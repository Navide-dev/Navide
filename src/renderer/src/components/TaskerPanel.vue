<script lang="ts">
// Tasker tab of the right-hand rail: everything that runs on a schedule on
// this Mac, as one "what runs next" list — Navide's own jobs, the user's Unix
// crontab, and the launchd jobs (~/Library/LaunchAgents, /Library/LaunchAgents,
// /Library/LaunchDaemons). Rows are sorted into four groups by
// lib/taskerTimeline.ts: a timeline of exactly-known next runs followed by the
// fixed-interval rows, then always-on / on-demand, and disabled. Only crontab entries and the
// user's own LaunchAgents (`managed`) get action buttons; system launchd jobs
// are shown for visibility and are read-only.
// All scanning and mutation lives in the backend (`executions.*` and
// `scheduler.*` RPC); this panel only renders and confirms.
//
// Laid out for a ~300px column (the rail is resizable down to 180px): every row
// is two compact lines, and the long strings (command, raw line, plist path)
// live in an expandable detail block that scrolls instead of widening the rail.
import type { ExecutionsSnapshot as CachedSnapshot } from '../lib/cronDescribe'

// Module scope on purpose (a `<script setup>` binding would be per-instance):
// this panel lives under a `v-else-if`, so switching rail tabs or collapsing the
// rail unmounts it. Without the cache every remount would shell out to
// `crontab -l` + `launchctl list` again.
let cachedSnapshot: CachedSnapshot | null = null
let cachedAt = 0
const CACHE_TTL_MS = 30_000
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import { useSchedulerJobs } from '../composables/useSchedulerJobs'
import {
  describeCron,
  describeLaunchAgentSchedule,
  type CrontabEntry,
  type ExecutionsSnapshot,
  type LaunchAgentEntry,
  type Translate,
} from '../lib/cronDescribe'
import type { SchedulerJob } from '../lib/schedulerJobs'
import { openEvolvePanel } from '../composables/useEvolve'
import {
  agentKey,
  bucketOf,
  classifyAgent,
  classifyCron,
  classifyJob,
  sortItems,
  vendorPrefixes,
  type Bucket,
  type Group,
  type TaskerItem,
} from '../lib/taskerTimeline'
import JobEditorModal from './JobEditorModal.vue'
import SchedulerJobRow from './SchedulerJobRow.vue'
import { vTruncate } from '@navide/plugin-ui/foundation'

type Kind = 'crontab' | 'launchagent'
type FoldGroup = Exclude<Group, 'timeline' | 'interval'>
/** Timeline rows: a day bucket, or the fixed-interval tail below the divider. */
type RowBucket = Bucket | 'interval'

// Inline (not a named `Props` interface): with the module-scope `<script>` block
// above, a local interface name would leak into the default export's type.
const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()

const { t, locale } = useI18n()
// vue-i18n's overloaded `t` doesn't match the plain (key, params) seam the
// describe helpers take; adapt once here rather than casting at every call.
const tr: Translate = (key, params) => (params ? t(key, params) : t(key))

const jobsApi = useSchedulerJobs(props.backend)

/** Identifies one row across both OS sources. Rows are addressed by (kind, key)
 *  rather than by the string sent to the backend, because two crontab lines can
 *  be byte-identical — comparing raw lines would light up both of them. */
interface RowRef {
  kind: Kind
  key: string
}

const snapshot = ref<ExecutionsSnapshot | null>(null)
const scanError = ref('')
/** Row currently being mutated. One mutation at a time: crontab writes are
 *  read-modify-write, so overlapping them would race. */
const busyTarget = ref<RowRef | null>(null)
const opError = reactive<Record<Kind, string>>({ crontab: '', launchagent: '' })
/** Row awaiting delete confirmation; the prompt renders inside its own row. */
const pendingRemove = ref<RowRef | null>(null)
/** Row whose ⋯ menu is open (at most one). */
const menuKey = ref<string | null>(null)

/** In-flight `executions.list` requests — drives the ↻ button's spin/disabled. */
const inflight = ref(0)
const scanning = computed(() => inflight.value > 0)
const busy = computed(() => busyTarget.value !== null)

function isPending(kind: Kind, key: string): boolean {
  const p = pendingRemove.value
  return p !== null && p.kind === kind && p.key === key
}

const crontab = computed(() => snapshot.value?.crontab ?? null)
const launchAgents = computed(() => snapshot.value?.launch_agents ?? null)

/** True when the backend could list nothing at all here: every source it
 *  knows reported itself unsupported. Windows today. One platform-level line
 *  says what is actually the case instead of naming crontab and launchd to a
 *  Windows user. Derived from the snapshot, not from the platform id, so it
 *  stays true wherever both sources are absent. */
const noSourceOnPlatform = computed(() =>
  crontab.value !== null && launchAgents.value !== null
  && !crontab.value.supported && !launchAgents.value.supported
)

/** A LaunchAgent counts as up when launchd has it either running or loaded.
 *  Never true for a job whose state is unknown — both fields are null then. */
function isAgentUp(agent: LaunchAgentEntry): boolean {
  return agent.running === true || agent.loaded === true
}

// ─────────────────────── Grouping ───────────────────────

interface SectionRow {
  item: TaskerItem
  bucket: RowBucket
}

const vendors = computed(() => vendorPrefixes(launchAgents.value?.agents ?? []))

const items = computed<TaskerItem[]>(() => {
  const now = jobsApi.now.value
  const out: TaskerItem[] = []
  for (const job of jobsApi.jobs.value) out.push(classifyJob(job, jobsApi.light(job) === 'err'))
  for (const entry of crontab.value?.entries ?? []) out.push(classifyCron(entry, now))
  for (const agent of launchAgents.value?.agents ?? []) out.push(classifyAgent(agent, now))
  return out
})

function itemsIn(group: Group): TaskerItem[] {
  return sortItems(
    items.value.filter((i) => i.group === group),
    group
  )
}

const failing = computed(() => sortItems(items.value.filter((i) => i.failing), 'other'))
const onlyFailing = ref(false)
// Nothing left to show under the filter once the last failure clears.
watch(
  () => failing.value.length,
  (n) => {
    if (n === 0) onlyFailing.value = false
  }
)

const timeline = computed<SectionRow[]>(() => {
  const now = jobsApi.now.value
  return [
    ...itemsIn('timeline').map((item) => ({ item, bucket: bucketOf(item.next ?? now, now) })),
    ...itemsIn('interval').map((item) => ({ item, bucket: 'interval' as const })),
  ]
})

const FOLD_GROUPS: FoldGroup[] = ['other', 'disabled']
const FOLD_DEFAULTS: Record<FoldGroup, boolean> = { other: false, disabled: false }

const folds = computed(() =>
  FOLD_GROUPS.map((id) => ({ id, items: itemsIn(id) })).filter((g) => g.items.length > 0)
)

// Per-viewer convenience only: storage may be unavailable, and the defaults are
// a complete answer on their own.
function readOpen(id: FoldGroup): boolean {
  try {
    const v = localStorage.getItem(`tasker.group.${id}`)
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    /* ignore */
  }
  return FOLD_DEFAULTS[id]
}
const openGroups = reactive<Record<FoldGroup, boolean>>({
  other: readOpen('other'),
  disabled: readOpen('disabled'),
})
function toggleGroup(id: FoldGroup): void {
  openGroups[id] = !openGroups[id]
  try {
    localStorage.setItem(`tasker.group.${id}`, openGroups[id] ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** What the body renders, top to bottom. Under "only failing" it is one flat
 *  list, so a failure inside a collapsed group is never hidden by the filter. */
const sections = computed<{ id: Group | 'failing'; rows: SectionRow[] }[]>(() => {
  const plain = (list: TaskerItem[]): SectionRow[] => list.map((item) => ({ item, bucket: 'today' }))
  if (onlyFailing.value) return [{ id: 'failing', rows: plain(failing.value) }]
  return [
    { id: 'timeline', rows: timeline.value },
    ...folds.value.map((g) => ({ id: g.id, rows: plain(g.items) })),
  ]
})

// ─────────────────────── Row text ───────────────────────

const scannedAtLabel = computed(() => {
  const at = snapshot.value?.scanned_at
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  return new Date(at * 1000).toLocaleTimeString(undefined, { hour12: false })
})

function clockOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** The small line above the clock in the time column: nothing for today and
 *  tomorrow (the bucket header says it), a weekday this week, a date later. */
function dayOf(ms: number, bucket: RowBucket): string {
  if (bucket === 'week') return new Date(ms).toLocaleDateString(locale.value, { weekday: 'short' })
  if (bucket === 'later') return new Date(ms).toLocaleDateString(locale.value, { month: 'numeric', day: 'numeric' })
  return ''
}

/** The time column of a fixed-interval row: its cadence, never a clock time. */
function intervalOf(ms: number | null): string {
  if (ms === null) return '—'
  const s = Math.round(ms / 1000)
  if (s % 3600 === 0) return t('executions.interval.hours', { n: s / 3600 })
  if (s % 60 === 0) return t('executions.interval.minutes', { n: s / 60 })
  return t('executions.interval.seconds', { n: s })
}

function agentName(agent: LaunchAgentEntry): string {
  const vendor = vendors.value.get(agentKey(agent))
  return vendor ? `${vendor} · ${agent.name}` : agent.name
}

function agentStateNote(agent: LaunchAgentEntry): string {
  // Unknown must never be rendered as "not loaded": `launchctl list` cannot see
  // the system domain without root, so we genuinely do not know.
  if (!agent.runtime_known) return t('executions.state.unknown')
  if (agent.running) return ''
  if (agent.loaded) return t('executions.state.loaded-not-running')
  return t('executions.state.not-loaded')
}

/** Neutral dot for an unknown state — neither the green "up" nor the grey
 *  "stopped" reading would be true. */
function agentDotClass(agent: LaunchAgentEntry): Record<string, boolean> {
  if (!agent.runtime_known) return { unknown: true, err: agent.last_exit_code !== null && agent.last_exit_code !== 0 }
  return { idle: !isAgentUp(agent), err: agent.last_exit_code !== null && agent.last_exit_code !== 0 }
}

/** The error line shown for the jobs list. A backend older than this window
 *  answers every scheduler.* request with "Unsupported message type" — the
 *  fix is a restart, so say that instead of echoing the protocol error. */
const jobsError = computed(() => {
  const msg = jobsApi.listError.value
  if (!msg) return ''
  if (/unsupported message type/i.test(msg)) return t('executions.backend-outdated')
  return t('scheduler.list-failed', { message: msg })
})

// ─────────────────────── Row expand / menu ───────────────────────
// Same interaction vocabulary as HistoryPanel: click a row to toggle, expanded
// ids tracked in a Set that is replaced (not mutated) so Vue sees the change.
const expandedIds = ref<Set<string>>(new Set())
function toggle(id: string): void {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

function toggleMenu(key: string): void {
  menuKey.value = menuKey.value === key ? null : key
}

function copyText(text: string): void {
  menuKey.value = null
  void navigator.clipboard?.writeText(text).catch(() => {})
}

/** Drop expanded ids that no longer exist. Crontab ids are derived from the raw
 *  line and its index, so disabling or removing an entry renames it. */
function pruneExpanded(snap: ExecutionsSnapshot): void {
  const live = new Set<string>()
  for (const entry of snap.crontab?.entries ?? []) live.add(entry.id)
  for (const agent of snap.launch_agents?.agents ?? []) live.add(agentKey(agent))
  const next = new Set<string>()
  for (const id of expandedIds.value) if (live.has(id)) next.add(id)
  if (next.size !== expandedIds.value.size) expandedIds.value = next
}

// ─────────────────────── Job editor ───────────────────────

const editorOpen = ref(false)
const editing = ref<SchedulerJob | null>(null)

function openEditor(job: SchedulerJob | null): void {
  // A system job has no editor: the workspace's evolve panel manages it.
  if (job && jobsApi.isSystem(job)) {
    openEvolvePanel(jobsApi.systemWorkspace(job))
    return
  }
  editing.value = job
  editorOpen.value = true
}

function closeEditor(): void {
  editorOpen.value = false
  editing.value = null
}

function onSaved(): void {
  closeEditor()
  void jobsApi.refresh()
}

// ─────────────────────── Backend ───────────────────────

/** Every executions RPC shells out, and the service allows each command 10s.
 *  The client's 10s default leaves no headroom, so a slow `launchctl` would be
 *  reported as a client timeout instead of the backend's real error. */
const RPC_TIMEOUT_MS = 25_000

/** Scan generation. Refreshes may overlap (a broadcast can land mid-scan), so
 *  each one records its own number and only the newest response is applied —
 *  otherwise a slow pre-mutation scan would overwrite the post-mutation state. */
let scanSeq = 0

async function refresh(userInitiated = false): Promise<void> {
  // Scanning shells out to crontab/launchctl, so a request sent before the
  // backend is up would just burn the client timeout and leave the panel
  // permanently empty. The status watcher below re-runs this once connected.
  if (props.backend.status.value !== 'connected') return
  const seq = ++scanSeq
  inflight.value += 1
  scanError.value = ''
  // Only an explicit ↻ discards operation errors: a background refresh (mutation
  // follow-up or another window's broadcast) must not wipe an unread failure.
  if (userInitiated) {
    opError.crontab = ''
    opError.launchagent = ''
  }
  try {
    const resp = await props.backend.send<ExecutionsSnapshot>('executions.list', {}, RPC_TIMEOUT_MS)
    if (seq !== scanSeq) return
    if (resp.ok && resp.payload) {
      snapshot.value = resp.payload
      cachedSnapshot = resp.payload
      cachedAt = Date.now()
      pruneExpanded(resp.payload)
    } else scanError.value = resp.error?.message ?? 'executions.list failed'
  } catch (err) {
    if (seq !== scanSeq) return
    scanError.value = String((err as Error).message ?? err)
  } finally {
    inflight.value -= 1
  }
}

function rescan(): void {
  void refresh(true)
  void jobsApi.refresh()
}

/** Send a mutation and surface `ok: false` errors inline. */
async function mutate(
  kind: Kind,
  type: 'executions.set_enabled' | 'executions.remove',
  payload: Record<string, unknown>,
  key: string
): Promise<void> {
  if (busyTarget.value) return
  busyTarget.value = { kind, key }
  opError[kind] = ''
  try {
    const resp = await props.backend.send<{ ok: boolean; error?: string }>(
      type,
      payload,
      RPC_TIMEOUT_MS
    )
    if (!resp.ok) {
      opError[kind] = resp.error?.message ?? `${type} failed`
      return
    }
    if (resp.payload && resp.payload.ok === false) {
      opError[kind] = resp.payload.error ?? `${type} failed`
      return
    }
    await refresh()
  } catch (err) {
    opError[kind] = String((err as Error).message ?? err)
  } finally {
    busyTarget.value = null
  }
}

function toggleCron(entry: CrontabEntry): void {
  void mutate(
    'crontab',
    'executions.set_enabled',
    { kind: 'crontab', target: entry.raw, enabled: !entry.enabled },
    entry.id
  )
}

function toggleAgent(agent: LaunchAgentEntry): void {
  void mutate(
    'launchagent',
    'executions.set_enabled',
    { kind: 'launchagent', target: agent.label, enabled: !isAgentUp(agent) },
    agentKey(agent)
  )
}

function askRemove(kind: Kind, key: string): void {
  menuKey.value = null
  pendingRemove.value = { kind, key }
}

function cancelRemove(): void {
  pendingRemove.value = null
}

/** `key` addresses the row; `target` is what the backend expects (raw / label). */
function confirmRemove(kind: Kind, key: string, target: string): void {
  pendingRemove.value = null
  void mutate(kind, 'executions.remove', { kind, target }, key)
}

let offChanged: (() => void) | null = null
const closeMenu = (): void => {
  menuKey.value = null
}

onMounted(() => {
  // Any window's mutation rebroadcasts, so every open view stays in sync.
  offChanged = props.backend.on('executions.changed', () => {
    void refresh()
  })
  // A click anywhere else closes the open ⋯ menu (its own clicks stop here).
  window.addEventListener('click', closeMenu)
  // Show the cached scan first so a remount doesn't flash empty, then rescan
  // unless the cache is still fresh.
  if (cachedSnapshot) snapshot.value = cachedSnapshot
  if (!cachedSnapshot || Date.now() - cachedAt > CACHE_TTL_MS) void refresh()
})

// This panel mounts with the app when Tasker was the last active tab, i.e.
// while the backend is still starting. Rescan on (re)connect the way
// useTokens does, or a boot-time miss would never recover on its own.
watch(
  () => props.backend.status.value,
  (status, previous) => {
    if (status === 'connected' && previous !== 'connected') void refresh()
  }
)

onUnmounted(() => {
  offChanged?.()
  window.removeEventListener('click', closeMenu)
})
</script>

<template>
  <div class="tasker">
    <div class="tk-bar">
      <span class="tk-stamp" v-truncate>
        {{ scannedAtLabel ? t('executions.last-scan', { time: scannedAtLabel }) : '—' }}
      </span>
      <span v-if="jobsApi.limitMeter.value" class="tk-meter" data-test="agent-meter">
        {{ jobsApi.limitMeter.value }}
      </span>
      <button class="tk-add" data-test="add-job" :title="t('scheduler.editor.title-new')" @click="openEditor(null)">
        {{ t('scheduler.add') }}
      </button>
      <button
        class="tk-rescan"
        :disabled="scanning"
        :title="scanning ? t('executions.scanning') : t('executions.rescan')"
        @click="rescan"
      >
        <span class="tk-rescan-icon" :class="{ spinning: scanning }">↻</span>
      </button>
    </div>

    <div class="tk-body">
      <!-- ── One-line notices: errors never take more than a row ─────────── -->
      <p v-if="scanError" class="tk-hint tk-scan-error" :title="scanError">
        <span class="tk-hint-text" v-truncate>{{ t('executions.scan-failed', { message: scanError }) }}</span>
        <button class="tk-hint-btn" @click="rescan">{{ t('executions.retry') }}</button>
      </p>
      <p v-if="jobsError" class="tk-hint" data-test="jobs-error" :title="jobsApi.listError.value">
        <span class="tk-hint-text" v-truncate>{{ jobsError }}</span>
        <button class="tk-hint-btn" @click="jobsApi.refresh()">{{ t('executions.retry') }}</button>
      </p>
      <p v-if="jobsApi.opError.value" class="tk-hint" data-test="op-error">
        <span class="tk-hint-text" v-truncate>{{ jobsApi.opError.value }}</span>
      </p>
      <p
        v-for="notice in jobsApi.limitNotices.value"
        :key="notice.key"
        class="tk-hint"
        :data-test="`agent-limit-${notice.key}`"
      >
        <span class="tk-hint-text" v-truncate>{{ notice.text }}</span>
      </p>
      <template v-for="kind in (['crontab', 'launchagent'] as const)" :key="kind">
        <p v-if="opError[kind]" class="tk-hint tk-op-error" :data-error-section="kind">
          <span class="tk-hint-text" v-truncate>{{ opError[kind] }}</span>
        </p>
      </template>
      <p v-if="crontab?.supported && crontab.error" class="tk-hint tk-sec-error" data-error-source="crontab" :title="crontab.error">
        <span class="tk-hint-text" v-truncate>crontab · {{ crontab.error }}</span>
      </p>
      <p v-if="launchAgents?.supported && launchAgents.error" class="tk-hint tk-sec-error" data-error-source="launchagent" :title="launchAgents.error">
        <span class="tk-hint-text" v-truncate>launchd · {{ launchAgents.error }}</span>
      </p>

      <!-- ── Failure summary ──────────────────────────────────────────────── -->
      <div v-if="failing.length" class="tk-failing" data-test="failing-bar">
        <span class="tk-failing-dot" />
        <span class="tk-failing-text">{{ t('executions.failing', { count: failing.length }) }}</span>
        <button class="tk-chip" :class="{ on: onlyFailing }" data-test="only-failing" @click="onlyFailing = !onlyFailing">
          {{ onlyFailing ? t('executions.show-all') : t('executions.only-failing') }}
        </button>
      </div>

      <template v-for="section in sections" :key="section.id">
        <section class="tk-section" :data-section="section.id">
          <div v-if="section.id === 'timeline'" class="tk-sec-hdr">
            <span class="tk-sec-title" v-truncate>{{ t('executions.timeline.title') }}</span>
          </div>
          <div v-else-if="section.id === 'failing'" class="tk-sec-hdr">
            <span class="tk-sec-title" v-truncate>{{ t('executions.only-failing') }}</span>
            <span class="tk-count">{{ section.rows.length }}</span>
          </div>
          <button
            v-else
            class="tk-group"
            :aria-expanded="openGroups[section.id as FoldGroup]"
            @click="toggleGroup(section.id as FoldGroup)"
          >
            <span class="tk-caret">{{ openGroups[section.id as FoldGroup] ? '▾' : '▸' }}</span>
            <span class="tk-group-title" v-truncate>{{ t(`executions.group.${section.id}`) }}</span>
            <span v-if="section.rows.some((r) => r.item.failing)" class="tk-group-err">
              {{ t('executions.failing', { count: section.rows.filter((r) => r.item.failing).length }) }}
            </span>
            <span class="tk-count">{{ section.rows.length }}</span>
          </button>

          <template v-if="section.id === 'timeline' || section.id === 'failing' || openGroups[section.id as FoldGroup]">
            <template v-for="(row, idx) in section.rows" :key="row.item.key">
              <div
                v-if="section.id === 'timeline' && (idx === 0 || section.rows[idx - 1].bucket !== row.bucket)"
                class="tk-bucket"
                :class="{ divider: row.bucket === 'interval' }"
                :data-bucket="row.bucket"
              >
                {{ t(`executions.bucket.${row.bucket}`) }}
              </div>
              <div
                class="tk-item"
                :class="{ off: section.id === 'disabled', failing: row.item.failing }"
                :data-kind="row.item.kind"
              >
                <div v-if="section.id === 'timeline' && row.bucket === 'interval'" class="tk-when" data-test="interval-col">
                  <span class="tk-when-clock every">{{ intervalOf(row.item.intervalMs) }}</span>
                </div>
                <div v-else-if="section.id === 'timeline' && row.item.next !== null" class="tk-when" data-test="when-col">
                  <span v-if="dayOf(row.item.next, row.bucket)" class="tk-when-day">{{ dayOf(row.item.next, row.bucket) }}</span>
                  <span class="tk-when-clock">{{ clockOf(row.item.next) }}</span>
                </div>

                <!-- Navide job -->
                <SchedulerJobRow v-if="row.item.kind === 'job'" :job="row.item.job" :api="jobsApi" @edit="openEditor" />

                <!-- crontab entry -->
                <div v-else-if="row.item.kind === 'crontab'" class="tk-row" :data-entry-id="row.item.entry.id">
                  <div
                    class="tk-row-head"
                    :title="expandedIds.has(row.item.entry.id) ? t('executions.row.collapse') : t('executions.row.expand')"
                    @click="toggle(row.item.entry.id)"
                  >
                    <div class="tk-line1">
                      <span class="tk-dot" :class="{ idle: !row.item.entry.enabled }" />
                      <span class="tk-name" v-truncate>{{ row.item.entry.name }}</span>
                      <span class="tk-tag src">cron</span>
                      <span class="tk-acts">
                        <button
                          class="tk-act tk-act-toggle"
                          :disabled="busy"
                          :title="row.item.entry.enabled ? t('executions.action.disable') : t('executions.action.enable')"
                          @click.stop="toggleCron(row.item.entry)"
                        >
                          {{ row.item.entry.enabled ? '⏸' : '▶' }}
                        </button>
                        <button
                          class="tk-act tk-act-more"
                          :title="t('executions.action.more')"
                          @click.stop="toggleMenu(row.item.key)"
                        >
                          ⋯
                        </button>
                      </span>
                    </div>
                    <div class="tk-line2">
                      <span class="tk-desc" v-truncate>{{ describeCron(row.item.entry.schedule, tr) }}</span>
                    </div>
                  </div>

                  <div v-if="menuKey === row.item.key" class="tk-menu" @click.stop>
                    <button class="tk-menu-item" @click="copyText(row.item.entry.raw)">{{ t('executions.action.copy-raw') }}</button>
                    <button class="tk-menu-item tk-act-remove" :disabled="busy" @click="askRemove('crontab', row.item.entry.id)">
                      {{ t('executions.action.remove') }}…
                    </button>
                  </div>

                  <div v-if="expandedIds.has(row.item.entry.id)" class="tk-detail">
                    <div class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.schedule') }}</span>
                      <code class="tk-v">{{ row.item.entry.schedule }}</code>
                    </div>
                    <div class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.command') }}</span>
                      <code class="tk-v">{{ row.item.entry.command }}</code>
                    </div>
                    <div class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.raw') }}</span>
                      <code class="tk-v">{{ row.item.entry.raw }}</code>
                    </div>
                  </div>

                  <div v-if="isPending('crontab', row.item.entry.id)" class="tk-confirm">
                    <p class="tk-confirm-lead">
                      {{ t('executions.confirm.crontab', { name: row.item.entry.name }) }}
                    </p>
                    <code class="tk-confirm-detail">{{ row.item.entry.raw }}</code>
                    <p class="tk-confirm-warning">{{ t('executions.confirm.warning') }}</p>
                    <div class="tk-confirm-acts">
                      <button class="tk-confirm-cancel" @click.stop="cancelRemove">
                        {{ t('executions.confirm.cancel') }}
                      </button>
                      <button
                        class="tk-confirm-ok"
                        :disabled="busy"
                        @click.stop="confirmRemove('crontab', row.item.entry.id, row.item.entry.raw)"
                      >
                        {{ t('executions.confirm.ok') }}
                      </button>
                    </div>
                  </div>
                </div>

                <!-- launchd job -->
                <div
                  v-else
                  class="tk-row"
                  :data-agent-label="row.item.agent.label"
                  :data-agent-key="row.item.key"
                  :data-scope="row.item.agent.scope"
                >
                  <div
                    class="tk-row-head"
                    :title="expandedIds.has(row.item.key) ? t('executions.row.collapse') : t('executions.row.expand')"
                    @click="toggle(row.item.key)"
                  >
                    <div class="tk-line1">
                      <span class="tk-dot" :class="agentDotClass(row.item.agent)" />
                      <span class="tk-name" v-truncate>{{ agentName(row.item.agent) }}</span>
                      <span v-if="row.item.agent.scope !== 'user'" class="tk-tag scope">
                        {{ t(`executions.scope.${row.item.agent.scope}`) }}
                      </span>
                      <span v-if="row.item.agent.pid !== null" class="tk-tag pid">
                        {{ t('executions.tag.pid', { pid: row.item.agent.pid }) }}
                      </span>
                      <span v-if="row.item.failing" class="tk-tag exit">
                        {{ t('executions.tag.exit', { code: row.item.agent.last_exit_code }) }}
                      </span>
                      <span class="tk-tag src">launchd</span>
                      <!-- Read-only rows get no buttons at all: everything outside
                           ~/Library/LaunchAgents needs root, which we never ask for. -->
                      <span v-if="row.item.agent.managed" class="tk-acts">
                        <button
                          class="tk-act tk-act-toggle"
                          :disabled="busy"
                          :title="isAgentUp(row.item.agent) ? t('executions.action.disable') : t('executions.action.enable')"
                          @click.stop="toggleAgent(row.item.agent)"
                        >
                          {{ isAgentUp(row.item.agent) ? '⏸' : '▶' }}
                        </button>
                        <button
                          class="tk-act tk-act-more"
                          :title="t('executions.action.more')"
                          @click.stop="toggleMenu(row.item.key)"
                        >
                          ⋯
                        </button>
                      </span>
                    </div>
                    <div class="tk-line2">
                      <span class="tk-desc" v-truncate>{{ describeLaunchAgentSchedule(row.item.agent, tr) }}</span>
                    </div>
                  </div>

                  <div v-if="menuKey === row.item.key" class="tk-menu" @click.stop>
                    <button class="tk-menu-item" @click="copyText(row.item.agent.label)">{{ t('executions.action.copy-label') }}</button>
                    <button class="tk-menu-item tk-act-remove" :disabled="busy" @click="askRemove('launchagent', row.item.key)">
                      {{ t('executions.action.remove') }}…
                    </button>
                  </div>

                  <div v-if="expandedIds.has(row.item.key)" class="tk-detail">
                    <div class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.label') }}</span>
                      <code class="tk-v">{{ row.item.agent.label }}</code>
                    </div>
                    <div class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.scope') }}</span>
                      <span class="tk-v">{{ t(`executions.scope.${row.item.agent.scope}`) }}</span>
                    </div>
                    <div class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.plist') }}</span>
                      <code class="tk-v">{{ row.item.agent.plist_path ?? '—' }}</code>
                    </div>
                    <div v-if="row.item.agent.last_exit_code !== null" class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.exit-code') }}</span>
                      <code class="tk-v">{{ row.item.agent.last_exit_code }}</code>
                    </div>
                    <div v-if="agentStateNote(row.item.agent)" class="tk-kv">
                      <span class="tk-k">{{ t('executions.detail.state') }}</span>
                      <span class="tk-v">{{ agentStateNote(row.item.agent) }}</span>
                    </div>
                  </div>

                  <div v-if="isPending('launchagent', row.item.key)" class="tk-confirm">
                    <p class="tk-confirm-lead">
                      {{ t('executions.confirm.launchagent', { name: row.item.agent.name }) }}
                    </p>
                    <code class="tk-confirm-detail">{{ row.item.agent.label }}</code>
                    <code v-if="row.item.agent.plist_path" class="tk-confirm-detail">{{ row.item.agent.plist_path }}</code>
                    <p class="tk-confirm-warning">{{ t('executions.confirm.warning') }}</p>
                    <div class="tk-confirm-acts">
                      <button class="tk-confirm-cancel" @click.stop="cancelRemove">
                        {{ t('executions.confirm.cancel') }}
                      </button>
                      <button
                        class="tk-confirm-ok"
                        :disabled="busy"
                        @click.stop="confirmRemove('launchagent', row.item.key, row.item.agent.label)"
                      >
                        {{ t('executions.confirm.ok') }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </template>

          <template v-if="section.id === 'timeline'">
            <p v-if="!section.rows.length" class="tk-empty nv-empty nv-empty--inline">
              {{ t('executions.timeline.empty') }}
            </p>
            <p v-if="!jobsApi.jobs.value.length && !jobsApi.listError.value" class="tk-cta" data-test="jobs-empty">
              <span>{{ t('scheduler.empty') }}</span>
              <button class="tk-hint-btn" @click="openEditor(null)">{{ t('executions.create-first') }}</button>
            </p>
          </template>
        </section>
      </template>

      <!-- ── Platform notes ──────────────────────────────────────────────── -->
      <div v-if="noSourceOnPlatform" class="tk-platform" data-test="executions-no-source">
        <p class="tk-platform-note">{{ t('executions.no-source') }}</p>
        <p v-if="snapshot?.platform === 'win32'" class="tk-platform-note tk-platform-hint">
          {{ t('executions.no-source-windows') }}
        </p>
      </div>
      <template v-else>
        <p v-if="crontab && !crontab.supported" class="tk-unsupported" data-unsupported="crontab">
          crontab · {{ t('executions.unsupported') }}
        </p>
        <p v-if="launchAgents && !launchAgents.supported" class="tk-unsupported" data-unsupported="launchagent">
          launchd · {{ t('executions.unsupported') }}
        </p>
      </template>
    </div>

    <JobEditorModal
      :open="editorOpen"
      :job="editing"
      :backend="backend"
      @close="closeEditor"
      @saved="onSaved"
      @removed="onSaved"
    />
  </div>
</template>

<style scoped>
.tasker {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.tk-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.tk-stamp {
  flex: 1;
  min-width: 0;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-meter {
  flex: none;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  white-space: nowrap;
}
.tk-add,
.tk-rescan {
  flex: none;
  appearance: none;
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  padding: 0 6px;
  font-size: var(--font-2xs);
  line-height: 1.7;
}
.tk-add {
  color: var(--accent-fg);
  border-color: var(--accent-muted);
}
.tk-add:hover,
.tk-rescan:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.tk-rescan:disabled {
  opacity: 0.5;
  cursor: default;
}
.tk-rescan-icon.spinning {
  display: inline-block;
  animation: tk-spin 1s linear infinite;
}
@keyframes tk-spin {
  to {
    transform: rotate(360deg);
  }
}

/* The single scroll region of the panel. */
.tk-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

/* One-line notices: a red dot, the message cut to one line (full text in
   `title`), and an optional action. Never a block that pushes the list down. */
.tk-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 4px 10px;
  font-size: var(--font-3xs);
  color: var(--danger-bright);
  border-bottom: 1px solid var(--bg-subtle);
}
.tk-hint::before {
  content: '';
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--danger-fg);
}
.tk-hint-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-hint-btn {
  flex: none;
  appearance: none;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  color: var(--accent-fg);
  padding: 0 6px;
  font-size: var(--font-3xs);
  line-height: 1.6;
  cursor: pointer;
}
.tk-hint-btn:hover {
  background: var(--bg-hover);
}

.tk-failing {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--danger-subtle);
  border-bottom: 1px solid var(--danger-muted);
}
.tk-failing-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--danger-fg);
}
.tk-failing-text {
  flex: 1;
  min-width: 0;
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--danger-bright);
}
.tk-chip {
  flex: none;
  appearance: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-pill);
  background: var(--bg-base);
  padding: 1px 8px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  cursor: pointer;
}
.tk-chip:hover {
  background: var(--bg-hover);
}
.tk-chip.on {
  background: var(--accent-subtle);
  border-color: var(--accent-muted);
  color: var(--accent-fg);
}

.tk-section {
  border-bottom: 1px solid var(--bg-subtle);
}
.tk-sec-hdr {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 8px 10px 4px;
}
.tk-sec-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-count {
  flex: none;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.tk-group {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  appearance: none;
  border: none;
  background: var(--bg-subtle);
  padding: 6px 10px;
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
}
.tk-group:hover {
  background: var(--bg-hover);
}
.tk-caret {
  flex: none;
  width: 10px;
  font-size: 9px;
  color: var(--text-secondary);
}
.tk-group-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-2xs);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-group-err {
  flex: none;
  font-size: var(--font-3xs);
  color: var(--danger-fg);
}
.tk-bucket {
  padding: 6px 10px 2px;
  font-size: var(--font-3xs);
  font-weight: 700;
  color: var(--text-secondary);
}
/* Fixed-interval rows follow the dated ones, below a thin rule. */
.tk-bucket.divider {
  margin-top: 4px;
  border-top: 1px solid var(--border-muted);
}

/* One list row: the time column (timeline only) + the row itself. */
.tk-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 5px 10px;
  border-top: 1px solid var(--bg-subtle);
}
.tk-item:hover {
  background: var(--bg-subtle);
}
/* Only switched-off rows fade: a launchd job that is idle between runs is
   the normal state, not something to grey out. */
.tk-item.off {
  opacity: 0.65;
}
.tk-item.failing {
  box-shadow: inset 2px 0 0 var(--danger-fg);
}
.tk-when {
  flex: none;
  width: 40px;
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  padding-top: 1px;
}
.tk-when-day {
  font-size: 9px;
  color: var(--text-secondary);
}
.tk-when-clock {
  font-size: var(--font-2xs);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-bright);
}
.tk-when-clock.every {
  font-weight: 400;
  color: var(--text-secondary);
}

.tk-row {
  flex: 1;
  min-width: 0;
}
.tk-row-head {
  cursor: pointer;
}
.tk-line1 {
  display: flex;
  align-items: center;
  /* The PID / exit tags don't shrink; let them drop to a second line instead of
     being clipped when the rail is near its 180px minimum. */
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}
.tk-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--success-fg);
}
.tk-dot.idle {
  background: var(--text-disabled);
}
.tk-dot.err {
  background: var(--danger-fg);
}
/* Hollow, so it reads as "no state to report" rather than as either the green
   running dot or the grey stopped one. */
.tk-dot.unknown {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--text-disabled);
}
.tk-name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-tag {
  flex: none;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  padding: 0 4px;
  font-size: 9px;
  font-weight: 700;
  color: var(--text-secondary);
  white-space: nowrap;
}
.tk-tag.pid {
  color: var(--success-fg);
  border-color: var(--success-muted);
  background: var(--success-subtle);
}
.tk-tag.exit {
  color: var(--danger-fg);
  border-color: var(--danger-muted);
  background: var(--danger-subtle);
}
.tk-tag.scope {
  font-weight: 600;
  text-transform: none;
}
.tk-tag.src {
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
.tk-line2 {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  margin-top: 2px;
  padding-left: 11px;
}
.tk-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tk-acts {
  display: flex;
  flex: none;
  gap: 3px;
}
.tk-act {
  appearance: none;
  width: 24px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.tk-act-more {
  border-color: transparent;
}
.tk-act:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-hover);
}
.tk-act:disabled {
  opacity: 0.5;
  cursor: default;
}

.tk-menu {
  position: absolute;
  right: 10px;
  z-index: 5;
  min-width: 150px;
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-overlay);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
}
.tk-menu-item {
  appearance: none;
  border: none;
  background: transparent;
  padding: 3px 12px;
  text-align: left;
  font-size: var(--font-2xs);
  color: var(--text-primary);
  cursor: pointer;
}
.tk-menu-item:hover:not(:disabled) {
  background: var(--bg-hover);
}
.tk-menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}
/* The destructive entry sits last, behind a divider, in the danger colour. */
.tk-menu-item.tk-act-remove {
  margin-top: 3px;
  padding-top: 5px;
  border-top: 1px solid var(--border-muted);
  color: var(--danger-fg);
}

.tk-detail {
  padding: 4px 0 4px 11px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tk-kv {
  min-width: 0;
}
.tk-k {
  display: block;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
}
.tk-v {
  display: block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-3xs);
  color: var(--text-primary);
  word-break: break-all;
  white-space: pre-wrap;
}

.tk-confirm {
  margin: 4px 0 4px 11px;
  padding: 6px 8px;
  border: 1px solid var(--danger-muted);
  border-radius: var(--radius-control);
  background: var(--danger-subtle);
}
.tk-confirm-lead {
  margin: 0 0 4px;
  font-size: var(--font-2xs);
  color: var(--text-primary);
}
.tk-confirm-detail {
  display: block;
  margin-bottom: 4px;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-3xs);
  color: var(--text-primary);
  word-break: break-all;
  white-space: pre-wrap;
}
.tk-confirm-warning {
  margin: 0 0 6px;
  font-size: var(--font-3xs);
  color: var(--danger-bright);
}
.tk-confirm-acts {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.tk-confirm-cancel,
.tk-confirm-ok {
  appearance: none;
  border-radius: 3px;
  padding: 2px 10px;
  font-size: var(--font-2xs);
  cursor: pointer;
}
.tk-confirm-cancel {
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
}
.tk-confirm-ok {
  border: 1px solid var(--danger-muted);
  background: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.tk-confirm-ok:disabled {
  opacity: 0.5;
  cursor: default;
}

.tk-empty,
.tk-unsupported {
  margin: 0;
  padding: 6px 10px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.tk-cta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 10px 8px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.tk-platform {
  padding: 14px 14px 6px;
}
.tk-platform-note {
  margin: 0 0 8px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
  max-width: 44em;
}
.tk-platform-hint {
  font-size: var(--font-2xs);
}
</style>
