<script setup lang="ts">
// Resource Manager modal: every CLI this app is running, with what it is
// costing the machine right now. Hosted inside the main window, like Settings
// and the Pipeline Manager.
//
// Machine-wide on purpose. The backend owns one TerminalService for the whole
// app, so the sweep the host is already running covers panes in every window —
// which is the scope the question has ("what is eating my laptop"). The host
// passes that sampling loop in rather than this modal starting a second one.
//
// It owns no pane state. Names come from the backend roster (agent_msg.list —
// note it never lists plain terminal panes), the figures from the host's sweep,
// and the two row actions are relayed through the main process to whichever
// window owns the pane, because focusing and reclaiming only exist there.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import type { useResourceUsage } from '../composables/useResourceUsage'
import { useStorageUsage } from '../composables/useStorageUsage'
import type { ResourceSummaryRow } from './ResourceSummaryPanel.vue'
import StorageSection from './StorageSection.vue'
import { formatBytes } from '../lib/formatBytes'
import { formatCpuPercent, machineCpuShare, machineMemoryShare } from '../lib/resourceSampling'
import { idleReclaimDisabled } from '../lib/idleReclaim'

const props = defineProps<{
  open: boolean
  backend: ReturnType<typeof useBackend>
  /** The host's sampling loop — shared, not duplicated. */
  usage: ReturnType<typeof useResourceUsage>
  /** This window's own panes, as the host resolved them. Authoritative: the
   *  host knows each pane's terminal session id, so its figures survive a
   *  rebuild that moves the pane id. The roster below only has pane ids. */
  localRows: ResourceSummaryRow[]
  /** Read-only mirror of the Settings › General rows. */
  autoReclaimOn: boolean
  autoReclaimMinutes: string
  /** Workspaces the app knows about — the storage scan walks them too. */
  workspacePaths?: string[]
}>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()

// "Never" is a sentinel, not a duration: rendering it through the line that
// ends in "min" would read "idle never min". The state half already says off,
// so the whole line collapses to that.
const autoReclaimNever = computed(() => idleReclaimDisabled(props.autoReclaimMinutes))

// ── The roster: who exists ──────────────────────────────────────────────────
interface RosterPane {
  pane_id?: string
  name?: string
  workspace_label?: string
  agent_key?: string
  busy?: boolean
  offline?: boolean
}
const roster = ref<RosterPane[]>([])
const ROSTER_POLL_MS = 5_000
let rosterTimer: ReturnType<typeof setInterval> | null = null

async function refreshRoster(): Promise<void> {
  if (props.backend.status.value !== 'connected') return
  try {
    const resp = await props.backend.send<{ panes?: RosterPane[] }>('agent_msg.list', {})
    roster.value = (resp.payload?.panes ?? []).filter((p) => p.pane_id)
  } catch {
    // Keep the last list: a dropped request is not an empty machine.
  }
}

// Only while it is open: a closed modal polling the roster is pure cost, and
// the host stops the measurement sweep on the same signal.
watch(
  () => props.open,
  (open) => {
    if (rosterTimer !== null) {
      clearInterval(rosterTimer)
      rosterTimer = null
    }
    if (!open) return
    void refreshRoster()
    rosterTimer = setInterval(() => void refreshRoster(), ROSTER_POLL_MS)
  },
  { immediate: true }
)
// The open→false branch above is the normal stop; an unmount while open (the
// host tears the modal down) must not leave the interval polling a dead
// instance.
onBeforeUnmount(() => {
  if (rosterTimer !== null) {
    clearInterval(rosterTimer)
    rosterTimer = null
  }
})

// Recent CPU per pane, for the trend line. Kept only while the modal is open:
// a sparkline is a "what just happened", and persisting it would mean sampling
// with nobody watching.
const TREND_POINTS = 30
const trends = ref(new Map<string, number[]>())
watch(
  () => props.usage.cpuPercentByPaneId.value,
  (current) => {
    if (!props.open) return
    const next = new Map<string, number[]>()
    for (const [paneId, percent] of current) {
      const prior = trends.value.get(paneId) ?? []
      const series = percent === null ? prior : [...prior, percent].slice(-TREND_POINTS)
      next.set(paneId, series)
    }
    trends.value = next
  }
)
watch(
  () => props.open,
  (open) => {
    if (!open) trends.value = new Map()
  }
)

// ── Rows ────────────────────────────────────────────────────────────────────
type RowStatus = 'running' | 'awaiting' | 'idle' | 'disconnected'
interface ResourceRow {
  paneId: string
  name: string
  vendor: string
  workspace: string
  status: RowStatus
  bytes: number
  cpuPercent: number | null
  trend: number[]
}

// Rows come from three places, in order of how much each one knows.
//
// 1. The host's own rows. It resolved every pane in THIS window against the
//    terminal session id, which survives a rebuild that moves the pane id —
//    keyed by pane id alone these would read 0 B while their measurement sat
//    under the id the PTY was created with.
// 2. The roster, for panes belonging to other windows. Pane ids only, so the
//    same rebuild drift applies; a name with no figures is still worth showing.
// 3. Whatever the sweep measured that neither of the above claimed — plain
//    terminal panes, which never register in the roster, and are exactly what
//    you open this to find when a shell is running a build.
const rows = computed<ResourceRow[]>(() => {
  const bytes = props.usage.bytesByPaneId.value
  const cpu = props.usage.cpuPercentByPaneId.value
  const out: ResourceRow[] = []
  const seenPanes = new Set<string>()
  const claimedMeasurements = new Set<string>()

  for (const row of props.localRows) {
    seenPanes.add(row.paneId)
    claimedMeasurements.add(row.measuredKey)
    // The host's status vocabulary is richer than the roster's; collapse it to
    // the states this table draws. 'awaiting' is kept rather than folded into
    // 'running': a pane blocked on a permission prompt is the one you most want
    // to find in this list, and painting it green hid it among the busy ones.
    const status: RowStatus =
      row.status === 'disconnected'
        ? 'disconnected'
        : row.status === 'awaiting'
          ? 'awaiting'
          : row.status === 'running'
            ? 'running'
            : 'idle'
    out.push({
      paneId: row.paneId,
      name: row.name,
      vendor: row.vendor,
      workspace: row.foreignWorkspace,
      status,
      bytes: row.bytes,
      cpuPercent: row.cpuPercent,
      trend: trends.value.get(row.measuredKey) ?? [],
    })
  }

  for (const pane of roster.value) {
    const paneId = pane.pane_id as string
    if (seenPanes.has(paneId)) continue
    seenPanes.add(paneId)
    claimedMeasurements.add(paneId)
    out.push({
      paneId,
      name: pane.name || t('resource.unnamed-pane'),
      vendor: pane.agent_key ?? '',
      workspace: pane.workspace_label ?? '',
      status: pane.offline ? 'disconnected' : pane.busy ? 'running' : 'idle',
      bytes: bytes.get(paneId) ?? 0,
      cpuPercent: cpu.get(paneId) ?? null,
      trend: trends.value.get(paneId) ?? [],
    })
  }

  for (const paneId of bytes.keys()) {
    if (claimedMeasurements.has(paneId) || seenPanes.has(paneId)) continue
    out.push({
      paneId,
      name: t('resource.unnamed-pane'),
      vendor: '',
      workspace: '',
      status: 'idle',
      bytes: bytes.get(paneId) ?? 0,
      cpuPercent: cpu.get(paneId) ?? null,
      trend: trends.value.get(paneId) ?? [],
    })
  }
  return out
})

const filter = ref<'all' | 'running' | 'idle'>('all')
const sortBy = ref<'cpu' | 'memory' | 'name'>('memory')

const runningCount = computed(() => rows.value.filter((r) => r.status === 'running').length)
const idleCount = computed(() => rows.value.filter((r) => r.status !== 'running').length)

const visibleRows = computed(() => {
  const filtered = rows.value.filter((r) =>
    filter.value === 'all'
      ? true
      : filter.value === 'running'
        ? r.status === 'running'
        : r.status !== 'running'
  )
  return filtered.sort((a, b) => {
    if (sortBy.value === 'name') return a.name.localeCompare(b.name)
    if (sortBy.value === 'cpu') return (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || b.bytes - a.bytes
    return b.bytes - a.bytes || a.name.localeCompare(b.name)
  })
})

// Totals over what is listed, so the headline and the table always agree.
const totals = computed(() => {
  let bytes = 0
  let cpu = 0
  let cpuKnown = false
  for (const row of rows.value) {
    bytes += row.bytes
    if (row.cpuPercent !== null) {
      cpu += row.cpuPercent
      cpuKnown = true
    }
  }
  return { bytes, cpu: cpuKnown ? cpu : null }
})
const cpuShare = computed(() => machineCpuShare(totals.value.cpu, props.usage.cpuCount.value))
const memoryShare = computed(() =>
  machineMemoryShare(totals.value.bytes, props.usage.machineMemoryBytes.value)
)

function cpuText(percent: number | null): string {
  if (!props.usage.cpuAvailable.value) return '—'
  return formatCpuPercent(percent)
}
function sizeText(bytes: number): string {
  if (!props.usage.available.value) return '—'
  if (!props.usage.measured.value) return '…'
  return formatBytes(bytes)
}
function shareText(share: number | null): string {
  if (share === null) return t('resource.machine-share-unknown')
  return t('resource.machine-share', {
    percent: `${share < 10 ? share.toFixed(1) : Math.round(share)}%`,
  })
}

/** The trend line, scaled to its own maximum: the shape of the last minute is
 *  the point, not the absolute height, which the CPU column already gives. */
function sparkPoints(values: number[]): string {
  if (values.length < 2) return ''
  const max = Math.max(...values, 1)
  const step = 60 / (values.length - 1)
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(15 - (Math.max(0, v) / max) * 13).toFixed(1)}`)
    .join(' ')
}

// ── Row actions ─────────────────────────────────────────────────────────────
// Relayed even for panes in this window: the relay asks every main window and
// takes the answer from whichever one owns the pane, so one path covers both.
const rowNotice = ref<{ paneId: string; kind: 'blocked' | 'gone' } | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function flashNotice(paneId: string, kind: 'blocked' | 'gone'): void {
  rowNotice.value = { paneId, kind }
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    rowNotice.value = null
  }, 4_000)
}

async function paneAction(paneId: string, action: 'focus' | 'reclaim'): Promise<void> {
  const res = await window.agentTeam?.requestPaneAction?.({ paneId, action })
  if (res?.ok) {
    if (action === 'reclaim') {
      // A reclaimed pane keeps its roster entry (it becomes a placeholder), so
      // the figures are what change — re-measure rather than waiting a tick.
      void props.usage.refresh()
    } else {
      // Jumping means looking at that pane, not at this list.
      emit('close')
    }
    return
  }
  flashNotice(paneId, res?.error === 'blocked' ? 'blocked' : 'gone')
}

// ── Disk, on request ────────────────────────────────────────────────────────
// `storage.usage` walks several large trees (app data, every CLI profile home,
// every open workspace), so it is a button, not part of the sampling loop.
// One instance feeds both the Disk card up top and the Storage section below.
const storage = useStorageUsage({
  backend: props.backend,
  workspacePaths: () => props.workspacePaths,
})
const diskState = computed<'unscanned' | 'scanning' | 'failed' | 'scanned'>(() =>
  storage.scanning.value && !storage.report.value
    ? 'scanning'
    : storage.report.value
      ? 'scanned'
      : storage.scanError.value
        ? 'failed'
        : 'unscanned'
)
</script>

<template>
  <Teleport to="body">
    <div v-show="open" class="rm-overlay nv-modal-overlay" @click.self="emit('close')">
      <div class="rm-modal nv-modal-shell nv-modal-shell--wide" @click.stop>
        <div class="rm-head">
          <span class="rm-title">{{ t('resource.title') }}</span>
          <button class="rm-close" data-act="close" :title="t('resource.close')" @click="emit('close')">✕</button>
        </div>

        <div class="rm-summary">
          <div class="rm-metric" data-metric="cpu">
            <span class="rm-k">{{ t('resource.cpu') }}</span>
            <span class="rm-v" data-part="value">{{ cpuText(totals.cpu) }}</span>
            <span class="rm-sub">{{ shareText(cpuShare) }}</span>
          </div>
          <div class="rm-metric" data-metric="memory">
            <span class="rm-k">{{ t('resource.memory') }}</span>
            <span class="rm-v" data-part="value">{{ sizeText(totals.bytes) }}</span>
            <span class="rm-sub">{{ shareText(memoryShare) }}</span>
          </div>
          <div class="rm-metric rm-metric-disk" data-metric="disk" :data-state="diskState">
            <span class="rm-k">{{ t('resource.disk') }}</span>
            <span class="rm-v" data-part="value">
              {{ storage.report.value ? formatBytes(storage.report.value.totalBytes) : '—' }}
            </span>
            <span class="rm-sub" data-part="disk">
              {{ diskState === 'scanning'
                ? t('resource.disk-scanning')
                : diskState === 'failed'
                  ? t('resource.disk-failed')
                  : storage.report.value
                    ? t('resource.disk-free', {
                        free: formatBytes(storage.report.value.disk.freeBytes),
                        total: formatBytes(storage.report.value.disk.totalBytes),
                      })
                    : t('resource.disk-unscanned') }}
            </span>
          </div>
          <button
            v-if="!storage.report.value"
            class="rm-ghost rm-disk-scan"
            data-act="scan-disk"
            :disabled="storage.scanning.value || !storage.connected.value"
            @click="void storage.scan()"
          >
            {{ t('resource.disk-scan') }}
          </button>
          <span class="rm-spacer" />
          <button class="rm-ghost" data-act="refresh" @click="void usage.refresh()">
            {{ t('resource.refresh') }}
          </button>
        </div>

        <div class="rm-toolbar">
          <button
            v-for="f in (['all', 'running', 'idle'] as const)"
            :key="f"
            type="button"
            class="rm-tab"
            :class="{ on: filter === f }"
            :data-filter="f"
            @click="filter = f"
          >
            {{ f === 'all'
              ? t('resource.filter-all', { count: rows.length })
              : f === 'running'
                ? t('resource.filter-busy', { count: runningCount })
                : t('resource.filter-idle', { count: idleCount }) }}
          </button>
          <span class="rm-spacer" />
          <label class="rm-sort">
            <span>{{ t('resource.sort-label') }}</span>
            <select v-model="sortBy" data-act="sort">
              <option value="memory">{{ t('resource.sort-memory') }}</option>
              <option value="cpu">{{ t('resource.sort-cpu') }}</option>
              <option value="name">{{ t('resource.sort-name') }}</option>
            </select>
          </label>
        </div>

        <div class="rm-head-row">
          <span class="c-name">{{ t('resource.col-name') }}</span>
          <span class="c-trend">{{ t('resource.col-trend') }}</span>
          <span class="c-cpu">{{ t('resource.col-cpu') }}</span>
          <span class="c-mem">{{ t('resource.col-memory') }}</span>
          <span class="c-act" />
        </div>

        <div class="rm-rows">
          <div
            v-for="row in visibleRows"
            :key="row.paneId"
            class="rm-row"
            data-row="pane"
            :data-pane="row.paneId"
            :data-status="row.status"
          >
            <button class="c-name rm-jump" :title="t('resource.jump')" @click="void paneAction(row.paneId, 'focus')">
              <span class="rm-dot" />
              <span class="rm-name" v-truncate>{{ row.name }}</span>
              <span v-if="row.workspace || row.vendor" class="rm-meta" v-truncate>
                {{ [row.workspace, row.vendor].filter(Boolean).join(' · ') }}
              </span>
            </button>
            <span class="c-trend">
              <svg v-if="sparkPoints(row.trend)" viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden="true">
                <polyline :points="sparkPoints(row.trend)" />
              </svg>
            </span>
            <span class="c-cpu" data-part="cpu">{{ cpuText(row.cpuPercent) }}</span>
            <span class="c-mem" data-part="memory">{{ sizeText(row.bytes) }}</span>
            <span class="c-act">
              <button class="rm-mini" data-act="reclaim" @click="void paneAction(row.paneId, 'reclaim')">
                {{ t('resource.reclaim-row') }}
              </button>
            </span>
            <span v-if="rowNotice?.paneId === row.paneId" class="rm-notice" data-part="notice">
              {{ rowNotice.kind === 'blocked' ? t('resource.reclaim-blocked') : t('resource.pane-gone') }}
            </span>
          </div>
          <p v-if="visibleRows.length === 0" class="rm-empty" data-row="empty">
            {{ t('resource.window-empty') }}
          </p>
        </div>

        <StorageSection :storage="storage" />

        <div class="rm-foot">
          <span class="rm-foot-text">
            {{ autoReclaimNever
              ? t('resource.auto-reclaim-disabled')
              : t('resource.auto-reclaim', {
                state: autoReclaimOn ? t('resource.auto-reclaim-on') : t('resource.auto-reclaim-off'),
                minutes: autoReclaimMinutes,
              }) }}
          </span>
          <span class="rm-spacer" />
          <span class="rm-foot-note">
            {{ usage.available.value ? t('resource.note') : t('resource.unavailable') }}
          </span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* `.nv-modal-overlay` only skins the scrim — it deliberately sets no
 * display/position/overflow, so every modal positions its own overlay. Without
 * this block the card renders into the document flow with no size and no
 * stacking context: the modal opens and nothing appears. */
.rm-overlay {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 120);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.rm-modal {
  /* The shell class only skins the card — every modal here sets its own box,
   * the same way .pm-modal does. Without a width the table's own content is
   * what decides it, and a ten-row table decides "as wide as the screen". */
  width: min(var(--modal-w-wide), 92vw);
  height: min(760px, 86vh);
  display: flex;
  flex-direction: column;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  overflow: hidden;
}
.rm-spacer { flex: 1; }

.rm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.rm-title {
  flex: 1;
  font-weight: 600;
  font-size: var(--font-md);
  color: var(--text-bright);
}
.rm-close {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 3px 9px;
  font-size: var(--font-2xs);
  cursor: pointer;
}
.rm-close:hover { color: var(--text-bright); }

.rm-summary {
  display: flex;
  align-items: flex-end;
  gap: 28px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.rm-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.rm-k { color: var(--text-muted); font-size: var(--font-3xs); }
.rm-v {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-xl);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.rm-sub { color: var(--text-muted); font-size: var(--font-3xs); }

.rm-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.rm-tab {
  padding: 3px 10px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.rm-tab.on {
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-weight: 600;
}
.rm-sort {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: var(--font-2xs);
}
.rm-ghost {
  padding: 4px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.rm-ghost:hover { color: var(--text-bright); }
.rm-ghost:disabled { color: var(--text-disabled); cursor: default; }

.rm-head-row,
.rm-row {
  display: grid;
  grid-template-columns: 1fr 68px 62px 76px 72px;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
}
.rm-head-row {
  padding-top: 7px;
  padding-bottom: 7px;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  border-bottom: 1px solid var(--border-muted);
}
.rm-head-row .c-cpu,
.rm-head-row .c-mem { text-align: right; }

/* Shares the card's height with the Storage section below: closed, that is
 * one header line; open, it takes up to half and this keeps the rest. */
.rm-rows {
  flex: 1 1 auto;
  min-height: 120px;
  overflow-y: auto;
  padding-bottom: 8px;
}
.rm-row {
  position: relative;
  border-bottom: 1px solid var(--border-muted);
  min-height: 34px;
}
.rm-row:hover { background: var(--bg-hover-faint); }

.rm-jump {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.rm-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--attention-fg);
  align-self: center;
}
.rm-row[data-status='running'] .rm-dot { background: var(--success-fg); }
.rm-row[data-status='awaiting'] .rm-dot { background: var(--warning-fg); }
.rm-row[data-status='disconnected'] .rm-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--text-bright);
}
.rm-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.rm-meta {
  flex: none;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-trend svg {
  width: 60px;
  height: 15px;
  display: block;
}
.c-trend polyline {
  fill: none;
  stroke: var(--accent-fg);
  stroke-width: 1.2;
  opacity: 0.8;
}
.c-cpu,
.c-mem {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.c-mem { color: var(--text-bright); font-weight: 600; }
.c-act { text-align: right; }
.rm-mini {
  padding: 2px 8px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-3xs);
  cursor: pointer;
}
.rm-mini:hover { color: var(--text-bright); border-color: var(--border-default); }
.rm-notice {
  grid-column: 1 / -1;
  padding: 0 0 6px 13px;
  color: var(--attention-fg);
  font-size: var(--font-3xs);
}
.rm-empty {
  margin: 0;
  padding: 24px 16px;
  color: var(--text-muted);
  text-align: center;
}

.rm-metric-disk .rm-v { min-width: 4ch; }
.rm-metric-disk[data-state='unscanned'] .rm-v { color: var(--text-muted); }
.rm-disk-scan { align-self: center; }

.rm-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.rm-foot-note {
  max-width: 46ch;
  text-align: right;
  line-height: 1.45;
}
</style>
