<script setup lang="ts">
import { computed, ref, type Ref } from 'vue'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { executeCommand } from '@navide/plugin-ui/shared'
import { i18n, useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { useDevTime, formatDuration, type DevTimeTotals, type DevTimeWindow } from '../composables/useDevTime'
import type { useBackend } from '../composables/useBackend'

interface PaneRef {
  id: string
  agentKey?: string
  agentLabel: string
  roleLabel: string
}

interface Props {
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  /** The open panes of this window, in sidebar order. Rows are joined to the
   *  snapshot's by_pane figures by id; a pane the backend has no record of
   *  still lists, at zero. */
  panes: PaneRef[]
}

const props = defineProps<Props>()

const workspacePathRef: Ref<string> = computed(() => props.workspacePath) as unknown as Ref<string>
const { snapshot, loading, reset } = useDevTime(props.backend, workspacePathRef)

const EMPTY: DevTimeTotals = { merged_s: 0, human_s: 0, agent_s: 0, overlap_s: 0, wall_s: 0 }

// ─────────────────────── Totals ───────────────────────────────────────────

const CARDS: { window: DevTimeWindow; labelKey: string }[] = [
  { window: 'today', labelKey: 'devtime.today' },
  { window: 'last7d', labelKey: 'devtime.last-7d' },
  { window: 'all', labelKey: 'devtime.all' },
]

// The source breakdown reads whichever card was clicked last — "agent ran
// for hours while I was away" is a question about today most of the time,
// but the same bar answers it for the whole history too.
const selected = ref<DevTimeWindow>('today')

function totalsOf(w: DevTimeWindow): DevTimeTotals {
  return snapshot.value?.totals?.[w] ?? EMPTY
}

/** The small print under a card: elapsed clock time between the window's
 *  first and last activity, and how much of it was idle. Null when the window
 *  holds no interval — there is no span to speak of. */
function wallClockOf(w: DevTimeWindow): { wall: string; idle: number } | null {
  const t = totalsOf(w)
  const wall = t.wall_s ?? 0
  if (wall <= 0) return null
  const idle = Math.round(Math.max(0, Math.min(1, 1 - t.merged_s / wall)) * 100)
  return { wall: formatDuration(wall), idle }
}

// ─────────────────────── Source breakdown ─────────────────────────────────

const sources = computed(() => {
  const t = totalsOf(selected.value)
  const overlap = Math.max(0, t.overlap_s)
  const humanOnly = Math.max(0, t.human_s - overlap)
  const agentOnly = Math.max(0, t.agent_s - overlap)
  const total = Math.max(1, t.merged_s)
  const pct = (n: number) => `${Math.min(100, (n / total) * 100)}%`
  return {
    humanOnly, agentOnly, overlap,
    humanPct: pct(humanOnly), agentPct: pct(agentOnly), overlapPct: pct(overlap),
    empty: t.merged_s <= 0,
  }
})

// ─────────────────────── 7-day chart ──────────────────────────────────────

const days = computed(() => {
  const list = snapshot.value?.by_day ?? []
  const max = Math.max(1, ...list.map((d) => d.merged_s))
  return list.map((d) => {
    const [y, m, dd] = d.date.split('-').map(Number)
    const local = new Date(y, (m || 1) - 1, dd || 1)
    return {
      date: d.date,
      weekday: local.toLocaleDateString(i18n.global.locale.value, { weekday: 'short' }),
      value: formatDuration(d.merged_s),
      // A day with a few seconds still shows a sliver — a bar that reads as
      // empty while the tooltip says otherwise looks broken.
      height: d.merged_s > 0 ? `${Math.max(3, (d.merged_s / max) * 100)}%` : '0%',
      title: `${d.date} · ${formatDuration(d.merged_s)} (${i18n.global.t('devtime.human')} ${formatDuration(d.human_s)} · ${i18n.global.t('devtime.agent')} ${formatDuration(d.agent_s)})`,
    }
  })
})

// ─────────────────────── Per pane ─────────────────────────────────────────

const VENDOR_LABELS: Record<string, string> = Object.fromEntries(
  CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label])
)

const paneRows = computed(() => {
  const byId = new Map((snapshot.value?.by_pane ?? []).map((p) => [p.pane_id, p]))
  return (props.panes ?? [])
    .map((p) => {
      const rec = byId.get(p.id)
      return {
        id: p.id,
        label: p.agentLabel,
        sub: p.roleLabel,
        vendor: (p.agentKey && VENDOR_LABELS[p.agentKey]) || p.agentKey || '',
        today: rec?.today_s ?? 0,
        all: rec?.all_s ?? 0,
        active: rec?.active ?? false,
      }
    })
    .sort((a, b) => b.all - a.all)
})

// Same command the MCP ui_invoke path uses; App owns the focus logic.
function focusPane(paneId: string): void {
  executeCommand('ui.pane.focus', { paneId })
}

// ─────────────────────── Footer ───────────────────────────────────────────

const idleMinutes = computed(() => Math.round((snapshot.value?.gap_human_s ?? 300) / 60))

const { confirm: notifyConfirm } = useNotify()

async function confirmReset(): Promise<void> {
  const ok = await notifyConfirm(i18n.global.t('devtime.reset-confirm'), {
    title: i18n.global.t('devtime.reset-title'),
    confirmText: i18n.global.t('action.reset'),
  })
  if (!ok) return
  await reset()
}
</script>

<template>
  <div class="devtime">
    <div v-if="loading && !snapshot" class="msg">{{ $t('label.loading') }}</div>

    <div class="body">
      <!-- Totals: today / last 7 days / all time -->
      <section class="block">
        <div class="block-hdr">
          <span class="block-title">{{ $t('devtime.title') }}</span>
          <span v-if="snapshot?.active" class="dot on" :title="$t('devtime.counting')"></span>
        </div>
        <div class="totals">
          <button
            v-for="c in CARDS"
            :key="c.window"
            class="cell"
            :class="{ selected: selected === c.window }"
            @click="selected = c.window"
          >
            <div class="big" v-truncate>{{ formatDuration(totalsOf(c.window).merged_s) }}</div>
            <div class="lbl">{{ $t(c.labelKey) }}</div>
          </button>
        </div>
        <div v-if="wallClockOf(selected)" class="wall" v-truncate>
          {{ $t('devtime.wall-clock', { wall: wallClockOf(selected)!.wall, idle: wallClockOf(selected)!.idle }) }}
        </div>
      </section>

      <!-- Source breakdown of the selected window -->
      <section class="block">
        <div class="block-hdr"><span class="block-title">{{ $t('devtime.sources') }}</span></div>
        <div v-if="sources.empty" class="muted">{{ $t('devtime.no-data') }}</div>
        <template v-else>
          <div class="stack" role="img" :aria-label="$t('devtime.sources')">
            <span class="seg human" :style="{ width: sources.humanPct }"></span>
            <span class="seg overlap" :style="{ width: sources.overlapPct }"></span>
            <span class="seg agent" :style="{ width: sources.agentPct }"></span>
          </div>
          <div class="legend">
            <span><i class="sw human"></i>{{ $t('devtime.human-only') }} <b>{{ formatDuration(sources.humanOnly) }}</b></span>
            <span><i class="sw overlap"></i>{{ $t('devtime.overlap') }} <b>{{ formatDuration(sources.overlap) }}</b></span>
            <span><i class="sw agent"></i>{{ $t('devtime.agent-only') }} <b>{{ formatDuration(sources.agentOnly) }}</b></span>
          </div>
        </template>
      </section>

      <!-- Last 7 days -->
      <section class="block">
        <div class="block-hdr"><span class="block-title">{{ $t('devtime.daily') }}</span></div>
        <div v-if="!days.length" class="muted">{{ $t('devtime.no-data') }}</div>
        <div v-else class="chart">
          <div v-for="d in days" :key="d.date" class="col" :title="d.title">
            <span class="val">{{ d.value }}</span>
            <div class="track"><div class="bar" :style="{ height: d.height }"></div></div>
            <span class="day">{{ d.weekday }}</span>
          </div>
        </div>
      </section>

      <!-- By pane -->
      <section class="block">
        <div class="block-hdr"><span class="block-title">{{ $t('label.by-pane') }}</span></div>
        <div v-if="!paneRows.length" class="muted">{{ $t('label.no-active-panes') }}</div>
        <table v-else class="grid">
          <tbody>
            <tr v-for="row in paneRows" :key="row.id" class="pane-row" @click="focusPane(row.id)">
              <th :title="row.sub" v-truncate>
                <span class="dot" :class="{ on: row.active }"></span>
                {{ row.label }}
                <span v-if="row.vendor" class="vendor">{{ row.vendor }}</span>
              </th>
              <td v-truncate>{{ formatDuration(row.today) }}</td>
              <td class="dim" v-truncate>{{ formatDuration(row.all) }}</td>
            </tr>
            <tr class="head">
              <th></th><td v-truncate>{{ $t('devtime.today') }}</td><td class="dim" v-truncate>{{ $t('devtime.all') }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <footer class="foot">
        <span class="hint">{{ $t('devtime.idle-hint', { minutes: idleMinutes }) }}</span>
        <button class="reset-btn" :title="$t('devtime.reset-title')" @click="confirmReset">⟲</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Same vocabulary as the TOKENS tab (TokenStatsPanel.vue) so the two read as
   one panel; the styles are scoped there, so the shared classes are restated. */
.devtime {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--text-bright);
  font-size: var(--font-xs);
}
.msg { padding: 12px; color: var(--text-secondary); }
.body {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  padding: 8px 0;
  min-height: 0;
}
.block {
  padding: 8px 12px;
  border-bottom: 1px solid var(--bg-subtle);
}
.block-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.block-title {
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  flex: 1;
}
.muted { color: var(--text-secondary); font-size: var(--font-2xs); margin: 4px 0; }

.totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.cell {
  appearance: none;
  border: 1px solid transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-align: center;
  background: var(--bg-subtle);
  border-radius: 3px;
  padding: 6px 2px;
  overflow: hidden;
}
.cell:hover { border-color: var(--border-default); }
.cell.selected { border-color: var(--accent-fg); }
.big {
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lbl {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.wall {
  margin-top: 6px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ─────── source breakdown ─────── */
.stack {
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-subtle);
}
.seg { display: block; height: 100%; }
.seg.human, .sw.human { background: var(--accent-fg); }
.seg.overlap, .sw.overlap { background: var(--success-fg, #3fb950); }
.seg.agent, .sw.agent { background: var(--text-secondary); }
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 6px;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.legend b { color: var(--text-bright); font-weight: 600; font-variant-numeric: tabular-nums; }
.sw {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: middle;
}

/* ─────── 7-day chart ─────── */
.chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
  height: 84px;
}
.col {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
}
.val {
  font-size: var(--font-3xs);
  color: var(--text-bright);
  text-align: center;
  opacity: 0;
  white-space: nowrap;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.col:hover .val { opacity: 1; }
.track {
  flex: 1;
  display: flex;
  align-items: flex-end;
  background: var(--bg-subtle);
  border-radius: 2px;
  min-height: 0;
}
.bar {
  width: 100%;
  background: var(--accent-fg);
  border-radius: 2px 2px 0 0;
}
.col:hover .bar { background: var(--accent-emphasis); }
.day {
  font-size: 9px;
  color: var(--text-secondary);
  text-align: center;
  text-transform: uppercase;
  overflow: hidden;
  white-space: nowrap;
  margin-top: 2px;
}

/* ─────── per pane ─────── */
.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-2xs);
  table-layout: fixed;
}
.grid tr.head td, .grid tr.head th {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  border-top: 1px solid var(--border-muted);
  padding-top: 4px;
}
.grid th {
  text-align: left;
  font-weight: 500;
  color: var(--text-primary);
  padding: 3px 4px 3px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grid td {
  text-align: right;
  padding: 3px 4px;
  font-variant-numeric: tabular-nums;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 25%;
}
.grid td.dim { color: var(--text-secondary); }
.pane-row { cursor: pointer; }
.pane-row:hover th, .pane-row:hover td { background: var(--bg-subtle); }
.vendor {
  margin-left: 4px;
  font-size: 9px;
  color: var(--text-secondary);
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--border-default);
  margin-right: 5px;
  vertical-align: middle;
}
.dot.on { background: var(--success-fg, #3fb950); }

/* ─────── footer ─────── */
.foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
}
.hint {
  flex: 1;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
.reset-btn {
  appearance: none;
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  border-radius: 3px;
  padding: 0 6px;
  line-height: 1.7;
}
.reset-btn:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
</style>
