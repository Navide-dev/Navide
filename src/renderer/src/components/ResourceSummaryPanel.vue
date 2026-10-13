<script setup lang="ts">
// The status-bar summary card for CPU and memory.
//
// It replaces two popovers that answered halves of the same question — the
// agent list ("who is running") and the memory list ("who is holding the
// machine"). What you want at the moment the fan spins up is both at once, and
// only for the one or two panes that matter; the full table lives in the
// Resource Manager window, one click away at the bottom of this card.
//
// Everything is derived from props: the owner runs the sampling loop and owns
// the panes, this only renders and re-emits.
import { computed, onMounted, onUnmounted } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import { formatBytes } from '../lib/formatBytes'
import { formatCpuPercent } from '../lib/resourceSampling'
import { paneStatusLabelText, type PaneStatusValue } from '../lib/paneStatusLabel'
import { statusBadgeStyle } from '../composables/useStatusBadgePrefs'

export interface ResourceSummaryRow {
  paneId: string
  /** The key this row's figures were found under — the terminal session id
   *  when the host knows it, else the pane id. A pane rebuilt around a new PTY
   *  keeps the session id while its pane id moves on, so this is what tells
   *  another surface "that measurement is already spoken for". */
  measuredKey: string
  /** Display name — the rename/auto name when set, else the agent label. */
  name: string
  /** CLI vendor label; empty when it would merely repeat `name`. */
  vendor: string
  /** Basename of the pane's workspace when it differs from this window's. */
  foreignWorkspace: string
  status: PaneStatusValue
  /** Measured bytes for the pane's whole process tree; 0 when unmeasured. */
  bytes: number
  /** Percent of one core, or null before a second sample exists. */
  cpuPercent: number | null
  /** Whether "reclaim now" would take this one. */
  reclaimable: boolean
}

const props = defineProps<{
  rows: ResourceSummaryRow[]
  /** False while the first sweep is still in flight. */
  measured: boolean
  /** False when the platform cannot measure memory at all. */
  available: boolean
  /** False when the platform cannot measure CPU at all. */
  cpuAvailable: boolean
  /** Share of the whole machine, 0-100, or null when capacity is unknown. */
  cpuShare: number | null
  memoryShare: number | null
  totalBytes: number
  /** Sum of the per-pane figures, each relative to one core. */
  totalCpuPercent: number | null
}>()
const emit = defineEmits<{
  close: []
  reclaim: []
  jump: [paneId: string]
  openWindow: []
}>()

const { t } = useI18n()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const reclaimableCount = computed(() => props.rows.filter((r) => r.reclaimable).length)

// Busiest first, and a pane whose CPU is not yet known sorts below one whose
// is: the card exists to surface the outlier, and an unknown is not one.
const busiest = computed(() =>
  [...props.rows]
    .sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) || b.bytes - a.bytes)
    .slice(0, 3)
)

function cpuText(percent: number | null): string {
  if (!props.cpuAvailable) return '—'
  return formatCpuPercent(percent)
}

function sizeText(bytes: number): string {
  if (!props.available) return '—'
  if (!props.measured) return '…'
  return formatBytes(bytes)
}

function shareText(share: number | null): string {
  if (share === null) return t('resource.machine-share-unknown')
  return t('resource.machine-share', { percent: `${share < 10 ? share.toFixed(1) : Math.round(share)}%` })
}

/** Bar width as a share of the machine — the one denominator that means
 *  something here. Unknown capacity leaves the bar empty rather than guessing. */
function barWidth(share: number | null): string {
  if (share === null) return '0%'
  return `${Math.min(100, Math.max(0, share))}%`
}

function statusLabel(status: PaneStatusValue): string {
  return paneStatusLabelText(status)
}

/** The hover text carries what the row itself has no width for — the vendor
 *  and, when the pane came from another folder, which one. Two panes named
 *  "Fix the build" in two projects are otherwise indistinguishable here. */
function rowTitle(row: ResourceSummaryRow): string {
  const bits = [row.name, row.vendor, row.foreignWorkspace].filter(Boolean)
  return `${bits.join(' · ')} — ${t('resource.jump')}`
}
</script>

<template>
  <div class="rs-backdrop" @click="emit('close')" />
  <div class="rs-pop nv-popover" data-panel="resource-summary" @click.stop>
    <div class="rs-head">
      <span class="rs-head-title">{{ t('resource.title') }}</span>
      <button class="rs-btn" data-act="close" :title="t('resource.close')" @click="emit('close')">✕</button>
    </div>

    <div class="rs-cards">
      <div class="rs-card" data-card="cpu">
        <span class="rs-k">{{ t('resource.cpu') }}</span>
        <span class="rs-v" data-part="value">{{ cpuText(totalCpuPercent) }}</span>
        <span class="rs-bar"><i :style="{ width: barWidth(cpuShare) }" /></span>
        <span class="rs-sub" v-truncate>{{ cpuAvailable ? shareText(cpuShare) : t('resource.cpu-unavailable') }}</span>
      </div>
      <div class="rs-card" data-card="memory">
        <span class="rs-k">{{ t('resource.memory') }}</span>
        <span class="rs-v" data-part="value">{{ sizeText(totalBytes) }}</span>
        <span class="rs-bar"><i :style="{ width: barWidth(memoryShare) }" /></span>
        <span class="rs-sub" v-truncate>{{ shareText(memoryShare) }}</span>
      </div>
    </div>

    <div v-if="busiest.length > 0" class="rs-rows">
      <span class="rs-rows-title">{{ t('resource.busiest') }}</span>
      <button
        v-for="row in busiest"
        :key="row.paneId"
        type="button"
        class="rs-row"
        data-row="pane"
        :data-pane="row.paneId"
        :data-status="row.status"
        :style="statusBadgeStyle(row.status)"
        :title="rowTitle(row)"
        @click="emit('jump', row.paneId)"
      >
        <span class="rs-dot" :title="statusLabel(row.status)" />
        <span class="rs-name" v-truncate>{{ row.name }}</span>
        <span class="rs-cpu" data-part="cpu">{{ cpuText(row.cpuPercent) }}</span>
        <span class="rs-mem" data-part="memory">{{ sizeText(row.bytes) }}</span>
      </button>
    </div>
    <p v-else class="rs-empty nv-empty nv-empty--inline" data-row="empty">{{ t('resource.no-panes') }}</p>

    <div class="rs-foot">
      <button
        class="rs-reclaim"
        data-act="reclaim"
        :disabled="reclaimableCount === 0"
        @click="emit('reclaim')"
      >
        {{ reclaimableCount > 0
          ? t('resource.reclaim-action', { count: reclaimableCount })
          : t('resource.reclaim-action-empty') }}
      </button>
      <button class="rs-open" data-act="open-window" @click="emit('openWindow')">
        {{ t('resource.open-window') }}<span class="rs-chev">›</span>
      </button>
      <p class="rs-note">
        {{ available ? t('resource.note') : t('resource.unavailable') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.rs-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.rs-pop {
  position: fixed;
  /* Anchored to the pill, which lives on the LEFT of the status bar — a card
     that opens on the far side of the screen from what was clicked reads as a
     different control answering. */
  left: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 288px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.rs-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.rs-head-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
}
.rs-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  font-size: var(--font-3xs);
  cursor: pointer;
}
.rs-btn:hover { color: var(--text-bright); }

.rs-cards {
  display: flex;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid var(--border-muted);
}
.rs-card {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.rs-k { color: var(--text-muted); font-size: var(--font-3xs); }
.rs-v {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-md);
  font-variant-numeric: tabular-nums;
}
.rs-bar {
  height: 3px;
  border-radius: 99px;
  background: var(--bg-hover);
  overflow: hidden;
}
.rs-bar i {
  display: block;
  height: 100%;
  background: var(--accent-fg);
}
.rs-sub {
  color: var(--text-muted);
  font-size: var(--font-3xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rs-rows {
  display: flex;
  flex-direction: column;
  padding: 6px 4px;
}
.rs-rows-title {
  padding: 0 6px 4px;
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
.rs-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}
.rs-row:hover { background: var(--bg-hover); }
.rs-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  align-self: center;
}
/* Same dot vocabulary the agent list used, so a status reads the same after
 * the two panels merged. */
.rs-row[data-status='running'] .rs-dot { background: var(--status-badge-fg, var(--success-fg)); }
.rs-row[data-status='starting'] .rs-dot { background: var(--status-badge-fg, var(--status-starting-fg)); }
.rs-row[data-status='error'] .rs-dot,
.rs-row[data-status='exited'] .rs-dot { background: var(--status-badge-fg, var(--danger-fg)); }
.rs-row[data-status='idle'] .rs-dot { background: var(--status-badge-fg, var(--status-idle-fg)); }
.rs-row[data-status='awaiting'] .rs-dot { background: var(--status-badge-fg, var(--warning-fg)); }
.rs-row[data-status='stopped'] .rs-dot { background: var(--status-badge-fg, var(--text-disabled)); }
/* Hollow ring: a dropped connection is an absence, not a state the pane is in. */
.rs-row[data-status='disconnected'] .rs-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--status-badge-fg, var(--text-bright));
}
.rs-row[data-status='waiting'] .rs-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--status-badge-fg, var(--text-muted));
}
.rs-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.rs-cpu,
.rs-mem {
  flex: none;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}
.rs-cpu { min-width: 44px; text-align: right; }
.rs-mem { min-width: 52px; text-align: right; color: var(--text-bright); }
.rs-empty { padding: 12px 10px; }

.rs-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-muted);
}
.rs-reclaim,
.rs-open {
  width: 100%;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
  background: var(--bg-hover);
  color: var(--text-bright);
  font-size: var(--font-xs);
  cursor: pointer;
}
.rs-reclaim:disabled {
  color: var(--text-muted);
  cursor: default;
}
.rs-open {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: transparent;
}
.rs-open:hover:not(:disabled),
.rs-reclaim:hover:not(:disabled) { border-color: var(--border-default); }
.rs-chev { color: var(--text-muted); }
.rs-note {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  line-height: 1.5;
}
</style>
