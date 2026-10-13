<script setup lang="ts">
// Create / edit one Navide scheduled job. The only action a job has is "wake a
// CLI pane and send it this text", so the form is: when, which pane, what.
//
// The target list is the messaging roster (`agent_msg.list`, the same list the
// @-mention menu reads), grouped by workspace. Each option carries the pane's
// agent and the first 8 characters of its id, because two panes in one
// workspace may share a name and the job must pin the one the user picked:
// picking stores both pane_id (what the backend delivers to) and pane_name
// (what the row shows, and a readable trace once the pane is gone).
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import {
  HOUR_MS,
  MINUTE_MS,
  describeSchedule,
  formatDateTime,
  isValidHhmm,
  isValidTimeZone,
  localTimeZone,
  previewNextRun,
  shortId,
  type JobDraft,
  type JobSchedule,
  type SchedulerJob,
} from '../lib/schedulerJobs'
import { weekdayKey, type Translate } from '../lib/cronDescribe'
import { blockTourWhile } from '../composables/useTourBlockers'

const props = defineProps<{
  open: boolean
  /** The job being edited; null creates a new one. */
  job: SchedulerJob | null
  backend: ReturnType<typeof useBackend>
}>()
const emit = defineEmits<{ close: []; saved: [job: SchedulerJob]; removed: [id: string] }>()
// The welcome tour steps aside while the editor is open.
blockTourWhile(() => props.open)

const { t } = useI18n()
const tr: Translate = (key, params) => (params ? t(key, params) : t(key))

interface RosterPane {
  pane_id?: string
  name?: string
  workspace_path?: string
  workspace_label?: string
  workspace_display_name?: string
  agent_key?: string
}

type Freq = 'every' | 'daily' | 'weekly' | 'once'
const FREQS: Freq[] = ['every', 'daily', 'weekly', 'once']
/** ISO weekdays, Monday first. */
const DAYS = [1, 2, 3, 4, 5, 6, 7]
/** backend bounds: every_ms 60 000 … 7 days; max_runs_per_day 1 … 1440. */
const EVERY_MAX_MIN = 7 * 24 * 60
const RUNS_MAX = 1440

const name = ref('')
const freq = ref<Freq>('daily')
const everyMin = ref(60)
const at = ref('09:00')
const tz = ref(localTimeZone())
const days = ref<number[]>([1, 2, 3, 4, 5])
/** `<input type="datetime-local">` value, local wall clock to the minute. */
const onceAt = ref('')
/** What reset() put in onceAt, and the exact at_ms it stands for: an untouched
 *  field keeps the stored moment (seconds included) instead of re-deriving it. */
let onceInitial = ''
let onceInitialMs: number | null = null
const workspace = ref('')
/** Select value: a pane id, or `NAME_PREFIX + name` for a job that was created
 *  by name only (MCP) and has no pane id to show. */
const target = ref('')
const text = ref('')
const catchUp = ref<'once' | 'skip'>('once')
const maxRuns = ref(24)

const roster = ref<RosterPane[]>([])
const saving = ref(false)
const confirmingRemove = ref(false)
const serverError = ref('')
/** Validation stays silent until the first save attempt. */
const attempted = ref(false)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const NAME_PREFIX = 'name:'

function reset(job: SchedulerJob | null): void {
  attempted.value = false
  serverError.value = ''
  confirmingRemove.value = false
  saving.value = false
  now.value = Date.now()
  name.value = job?.name ?? ''
  const s = job?.schedule
  freq.value = s?.kind ?? 'daily'
  everyMin.value = s?.kind === 'every' ? Math.round(s.every_ms / MINUTE_MS) : 60
  at.value = s && (s.kind === 'daily' || s.kind === 'weekly') ? s.at : '09:00'
  tz.value = s && (s.kind === 'daily' || s.kind === 'weekly') ? s.tz : localTimeZone()
  days.value = s?.kind === 'weekly' ? [...s.days] : [1, 2, 3, 4, 5]
  onceInitialMs = s?.kind === 'once' ? s.at_ms : null
  // A new once job defaults to an hour from now, on the minute.
  onceAt.value = toLocalInput(onceInitialMs ?? Math.ceil((Date.now() + HOUR_MS) / MINUTE_MS) * MINUTE_MS)
  onceInitial = onceInitialMs === null ? '' : onceAt.value
  workspace.value = job?.action.workspace ?? ''
  target.value = job?.action.pane_id
    ? job.action.pane_id
    : job?.action.pane_name
      ? NAME_PREFIX + job.action.pane_name
      : ''
  text.value = job?.action.text ?? ''
  catchUp.value = job?.policy?.catch_up ?? 'once'
  maxRuns.value = job?.policy?.max_runs_per_day ?? 24
}

async function loadRoster(): Promise<void> {
  if (props.backend.status.value !== 'connected') return
  try {
    const resp = await props.backend.send<{ panes?: RosterPane[] }>('agent_msg.list', {})
    roster.value = (resp.payload?.panes ?? []).filter((p) => p.pane_id && p.workspace_path)
  } catch {
    // Keep the last list: a dropped request is not an empty machine.
  }
  // A new job with a single open workspace has only one sensible answer.
  if (!workspace.value && workspaceOptions.value.length === 1) {
    workspace.value = workspaceOptions.value[0].path
  }
}

watch(
  () => props.open,
  (open) => {
    if (clock !== null) {
      clearInterval(clock)
      clock = null
    }
    if (!open) return
    reset(props.job)
    void loadRoster()
    // Keeps the "next run" preview honest while the modal sits open.
    clock = setInterval(() => (now.value = Date.now()), 30_000)
  },
  { immediate: true }
)
onUnmounted(() => {
  if (clock !== null) clearInterval(clock)
})

const workspaceOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const p of roster.value) {
    const path = p.workspace_path as string
    if (!seen.has(path)) seen.set(path, p.workspace_display_name || p.workspace_label || path)
  }
  // The job's own workspace stays selectable even with no pane open there.
  if (workspace.value && !seen.has(workspace.value)) seen.set(workspace.value, workspace.value)
  return [...seen].map(([path, label]) => ({ path, label }))
})

const panesInWorkspace = computed(() =>
  roster.value.filter((p) => p.workspace_path === workspace.value)
)

function paneOptionLabel(p: RosterPane): string {
  return t('scheduler.editor.pane-option', {
    name: p.name ?? '',
    agent: p.agent_key ?? '?',
    id: shortId(p.pane_id),
  })
}

/** The job's current target when the roster no longer has it — shown as its
 *  own option so re-opening a job never silently retargets it. */
const missingTarget = computed<{ value: string; label: string } | null>(() => {
  const v = target.value
  if (!v) return null
  if (v.startsWith(NAME_PREFIX)) {
    return { value: v, label: t('scheduler.editor.pane-by-name', { name: v.slice(NAME_PREFIX.length) }) }
  }
  if (panesInWorkspace.value.some((p) => p.pane_id === v)) return null
  const oldName = props.job?.action.pane_id === v ? (props.job.action.pane_name ?? '') : ''
  return { value: v, label: t('scheduler.editor.pane-missing', { name: oldName, id: shortId(v) }) }
})

/** A pane belongs to one workspace; a target from the old one is meaningless.
 *  On the user's change only — `reset()` sets both fields together. */
function onWorkspacePicked(): void {
  target.value = ''
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** at_ms for the once field; NaN when the field is empty or malformed. */
const onceMs = computed(() => {
  if (onceInitialMs !== null && onceAt.value === onceInitial) return onceInitialMs
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(onceAt.value)
  if (!m) return Number.NaN
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()
})

function toggleDay(d: number): void {
  days.value = days.value.includes(d) ? days.value.filter((x) => x !== d) : [...days.value, d]
}

const schedule = computed<JobSchedule>(() => {
  if (freq.value === 'every') {
    const everyMs = Math.round(Number(everyMin.value)) * MINUTE_MS
    const prev = props.job?.schedule
    // Keep the phase of an unchanged interval; a changed one starts from now.
    const anchor = prev?.kind === 'every' && prev.every_ms === everyMs ? prev.anchor_ms : undefined
    return anchor !== undefined
      ? { kind: 'every', every_ms: everyMs, anchor_ms: anchor }
      : { kind: 'every', every_ms: everyMs }
  }
  if (freq.value === 'once') return { kind: 'once', at_ms: onceMs.value }
  if (freq.value === 'daily') return { kind: 'daily', at: at.value, tz: tz.value.trim() }
  return { kind: 'weekly', days: [...days.value].sort((a, b) => a - b), at: at.value, tz: tz.value.trim() }
})

const errors = computed<Record<string, string>>(() => {
  const e: Record<string, string> = {}
  if (!name.value.trim()) e.name = t('scheduler.editor.err-name')
  if (freq.value === 'every') {
    const n = Number(everyMin.value)
    if (!Number.isInteger(n) || n < 1 || n > EVERY_MAX_MIN)
      e.schedule = t('scheduler.editor.err-every', { max: EVERY_MAX_MIN })
  } else if (freq.value === 'once') {
    const ms = onceMs.value
    // The stored moment of a job being re-saved may lie in the past; a new one
    // may not (the backend allows one minute of slack).
    if (Number.isNaN(ms) || (ms !== onceInitialMs && ms < now.value - MINUTE_MS))
      e.schedule = t('scheduler.editor.err-once')
  } else {
    if (!isValidHhmm(at.value)) e.schedule = t('scheduler.editor.err-time')
    else if (!isValidTimeZone(tz.value.trim())) e.schedule = t('scheduler.editor.err-tz')
    else if (freq.value === 'weekly' && days.value.length === 0)
      e.schedule = t('scheduler.editor.err-days')
  }
  if (!workspace.value) e.workspace = t('scheduler.editor.err-workspace')
  if (!target.value) e.target = t('scheduler.editor.err-target')
  if (!text.value.trim()) e.text = t('scheduler.editor.err-text')
  const r = Number(maxRuns.value)
  if (!Number.isInteger(r) || r < 1 || r > RUNS_MAX)
    e.maxRuns = t('scheduler.editor.err-max-runs', { max: RUNS_MAX })
  return e
})
const shownErrors = computed(() => (attempted.value ? errors.value : {}))

const preview = computed(() => {
  if (errors.value.schedule) return ''
  const next = previewNextRun(schedule.value, now.value)
  if (next === null) return ''
  return t('scheduler.editor.next-preview', {
    time: formatDateTime(next),
    schedule: describeSchedule(schedule.value, tr),
  })
})

function buildDraft(): JobDraft {
  const v = target.value
  const byName = v.startsWith(NAME_PREFIX)
  const pane = byName ? undefined : roster.value.find((p) => p.pane_id === v)
  const paneName = byName
    ? v.slice(NAME_PREFIX.length)
    : (pane?.name ?? (props.job?.action.pane_id === v ? props.job.action.pane_name : undefined))
  const action: JobDraft['action'] = { kind: 'message', workspace: workspace.value, text: text.value.trim() }
  if (!byName) action.pane_id = v
  if (paneName) action.pane_name = paneName
  const draft: JobDraft = {
    name: name.value.trim(),
    enabled: props.job?.enabled ?? true,
    schedule: schedule.value,
    action,
    policy: {
      ...(props.job?.policy ?? {}),
      catch_up: catchUp.value,
      max_runs_per_day: Number(maxRuns.value),
    },
  }
  if (props.job) draft.id = props.job.id
  return draft
}

async function save(): Promise<void> {
  attempted.value = true
  serverError.value = ''
  if (Object.keys(errors.value).length || saving.value) return
  saving.value = true
  try {
    const resp = await props.backend.send<{ ok: boolean; job?: SchedulerJob; error?: string }>(
      'scheduler.upsert',
      { job: buildDraft() }
    )
    if (!resp.ok) serverError.value = resp.error?.message ?? 'scheduler.upsert failed'
    else if (!resp.payload || resp.payload.ok === false || !resp.payload.job)
      serverError.value = resp.payload?.error ?? 'scheduler.upsert failed'
    else emit('saved', resp.payload.job)
  } catch (err) {
    serverError.value = String((err as Error).message ?? err)
  } finally {
    saving.value = false
  }
}

async function remove(): Promise<void> {
  if (!props.job || saving.value) return
  saving.value = true
  serverError.value = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>('scheduler.remove', {
      id: props.job.id,
    })
    if (!resp.ok) serverError.value = resp.error?.message ?? 'scheduler.remove failed'
    else if (resp.payload && resp.payload.ok === false)
      serverError.value = resp.payload.error ?? 'scheduler.remove failed'
    else emit('removed', props.job.id)
  } catch (err) {
    serverError.value = String((err as Error).message ?? err)
  } finally {
    saving.value = false
    confirmingRemove.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <template v-if="open">
      <div class="je-backdrop nv-modal-overlay" @click="emit('close')" />
      <div
        class="je-card nv-modal-shell nv-modal-shell--standard"
        data-test="job-editor"
        role="dialog"
        @click.stop
        @keydown.esc="emit('close')"
      >
        <div class="je-title">
          {{ job ? t('scheduler.editor.title-edit') : t('scheduler.editor.title-new') }}
        </div>

        <div class="je-body">
          <label class="je-field">
            <span class="je-k">{{ t('scheduler.editor.name') }}</span>
            <input v-model="name" class="nv-input" data-field="name" type="text" spellcheck="false" />
            <span v-if="shownErrors.name" class="je-err" data-error="name">{{ shownErrors.name }}</span>
          </label>

          <div class="je-field">
            <span class="je-k">{{ t('scheduler.editor.frequency') }}</span>
            <div class="je-seg" role="radiogroup">
              <button
                v-for="f in FREQS"
                :key="f"
                type="button"
                class="je-seg-btn"
                :class="{ on: freq === f }"
                :data-freq="f"
                @click="freq = f"
              >
                {{ t(`scheduler.editor.freq-${f}`) }}
              </button>
            </div>
            <div v-if="freq === 'every'" class="je-row">
              <input
                v-model.number="everyMin"
                class="nv-input je-num"
                data-field="every"
                type="number"
                min="1"
                :max="EVERY_MAX_MIN"
              />
              <span class="je-unit">{{ t('scheduler.editor.minutes') }}</span>
            </div>
            <div v-else-if="freq === 'once'" class="je-row">
              <input v-model="onceAt" class="nv-input je-once" data-field="once" type="datetime-local" />
            </div>
            <template v-else>
              <div v-if="freq === 'weekly'" class="je-days">
                <button
                  v-for="d in DAYS"
                  :key="d"
                  type="button"
                  class="je-day"
                  :class="{ on: days.includes(d) }"
                  :data-day="d"
                  @click="toggleDay(d)"
                >
                  {{ t(weekdayKey(d)) }}
                </button>
              </div>
              <div class="je-row">
                <input v-model="at" class="nv-input je-time" data-field="at" type="time" />
                <input v-model="tz" class="nv-input je-tz" data-field="tz" type="text" spellcheck="false" />
              </div>
            </template>
            <span v-if="shownErrors.schedule" class="je-err" data-error="schedule">
              {{ shownErrors.schedule }}
            </span>
            <span v-if="preview" class="je-preview" data-test="next-preview">{{ preview }}</span>
          </div>

          <label class="je-field">
            <span class="je-k">{{ t('scheduler.editor.workspace') }}</span>
            <select v-model="workspace" class="nv-select" data-field="workspace" @change="onWorkspacePicked">
              <option value="" disabled>{{ t('scheduler.editor.pick-workspace') }}</option>
              <option v-for="w in workspaceOptions" :key="w.path" :value="w.path" :title="w.path">
                {{ w.label }}
              </option>
            </select>
            <span v-if="shownErrors.workspace" class="je-err" data-error="workspace">
              {{ shownErrors.workspace }}
            </span>
          </label>

          <label class="je-field">
            <span class="je-k">{{ t('scheduler.editor.target') }}</span>
            <select v-model="target" class="nv-select" data-field="target" :disabled="!workspace">
              <option value="" disabled>{{ t('scheduler.editor.pick-pane') }}</option>
              <option v-if="missingTarget" :value="missingTarget.value" data-missing="true">
                {{ missingTarget.label }}
              </option>
              <option v-for="p in panesInWorkspace" :key="p.pane_id" :value="p.pane_id">
                {{ paneOptionLabel(p) }}
              </option>
            </select>
            <span v-if="shownErrors.target" class="je-err" data-error="target">{{ shownErrors.target }}</span>
          </label>

          <label class="je-field">
            <span class="je-k">{{ t('scheduler.editor.text') }}</span>
            <textarea
              v-model="text"
              class="nv-input je-text"
              data-field="text"
              rows="3"
              :placeholder="t('scheduler.editor.text-placeholder')"
            />
            <span v-if="shownErrors.text" class="je-err" data-error="text">{{ shownErrors.text }}</span>
          </label>

          <div class="je-row je-policy">
            <label class="je-field">
              <span class="je-k">{{ t('scheduler.editor.catch-up') }}</span>
              <select v-model="catchUp" class="nv-select" data-field="catch-up">
                <option value="once">{{ t('scheduler.editor.catch-up-once') }}</option>
                <option value="skip">{{ t('scheduler.editor.catch-up-skip') }}</option>
              </select>
            </label>
            <label class="je-field">
              <span class="je-k">{{ t('scheduler.editor.max-runs') }}</span>
              <input
                v-model.number="maxRuns"
                class="nv-input je-num"
                data-field="max-runs"
                type="number"
                min="1"
                :max="RUNS_MAX"
              />
            </label>
          </div>
          <span v-if="shownErrors.maxRuns" class="je-err" data-error="max-runs">{{ shownErrors.maxRuns }}</span>

          <p v-if="serverError" class="je-server-err" data-test="editor-error">{{ serverError }}</p>
        </div>

        <div class="je-actions">
          <template v-if="job">
            <template v-if="confirmingRemove">
              <span class="je-confirm">{{ t('scheduler.editor.remove-confirm') }}</span>
              <button class="nv-btn nv-btn--danger" data-test="remove-ok" :disabled="saving" @click="remove">
                {{ t('scheduler.editor.remove') }}
              </button>
            </template>
            <button
              v-else
              class="nv-btn je-remove"
              data-test="remove"
              :disabled="saving"
              @click="confirmingRemove = true"
            >
              {{ t('scheduler.editor.remove') }}
            </button>
          </template>
          <span class="je-spacer" />
          <button class="nv-btn" data-test="cancel" @click="emit('close')">
            {{ t('scheduler.editor.cancel') }}
          </button>
          <button class="nv-btn nv-btn--primary" data-test="save" :disabled="saving" @click="save">
            {{ t('scheduler.editor.save') }}
          </button>
        </div>
      </div>
    </template>
  </Teleport>
</template>

<style scoped>
.je-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.je-card {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 1001;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
.je-title {
  flex: none;
  padding: 12px 16px 8px;
  font-weight: 600;
  color: var(--text-bright);
}
.je-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.je-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.je-k {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.je-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.je-policy > .je-field {
  flex: 1;
}
.je-num {
  width: 90px;
}
.je-time {
  width: 110px;
}
.je-once {
  width: 200px;
}
.je-tz {
  flex: 1;
  min-width: 0;
}
.je-unit {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.je-text {
  resize: vertical;
  font-family: inherit;
}
.je-seg,
.je-days {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.je-seg-btn,
.je-day {
  appearance: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: transparent;
  padding: 2px 10px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  cursor: pointer;
}
.je-seg-btn.on,
.je-day.on {
  background: var(--accent-subtle);
  border-color: var(--accent-muted);
  color: var(--accent-fg);
}
.je-preview {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.je-err,
.je-server-err {
  font-size: var(--font-2xs);
  color: var(--danger-bright);
}
.je-server-err {
  margin: 0;
  padding: 5px 8px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-control);
  background: var(--danger-subtle);
  word-break: break-word;
}
.je-actions {
  flex: none;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--border-muted);
}
.je-spacer {
  flex: 1;
}
.je-remove:hover:not(:disabled) {
  color: var(--danger-fg);
  border-color: var(--danger-fg);
}
.je-confirm {
  font-size: var(--font-2xs);
  color: var(--danger-bright);
}
</style>
