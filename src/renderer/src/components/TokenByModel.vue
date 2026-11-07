<script setup lang="ts">
// BY MODEL: the per-call ledger's tokens and dollars for this workspace's
// folder, per model, over the panel's day / week range. The week shows a
// stacked bar per day (largest models first, the rest as "other"); both
// ranges list the models in a table. Read-only.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import {
  fmtTokens, fmtUsd, groupTokens, rangeDays, utcOffsetMin,
  type CostGroup, type CostReport, type TokenRange,
} from '../lib/tokenViews'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  range: TokenRange
}>()

/** How many models get their own colour; the rest stack as "other". */
const STACKED = 4
const COLORS = ['var(--accent-fg)', 'var(--attention-fg)', 'var(--success-fg)', 'var(--done-fg)']

const groups = ref<CostGroup[]>([])
const error = ref('')
const days = computed(() => rangeDays(props.range))
let sequence = 0

async function load(): Promise<void> {
  if (props.backend.status.value !== 'connected' || !props.workspacePath) return
  const current = ++sequence
  const span = days.value
  const resp = await props.backend.send<CostReport>('tokens.cost_report', {
    by: 'day_model', cwd: props.workspacePath, since: span[0], until: span[span.length - 1],
    utc_offset_min: utcOffsetMin(),
  })
  if (current !== sequence) return
  if (!resp.ok || !resp.payload?.ok) {
    error.value = resp.payload?.error || resp.error?.message || 'failed'
    return
  }
  error.value = ''
  groups.value = resp.payload.groups
}

watch(
  () => [props.backend.status.value, props.workspacePath, props.range] as const,
  () => void load(),
  { immediate: true },
)
// The ledger grows with every call; follow it at most every 15 seconds.
let lastChange = 0
const unsub = props.backend.on('tokens.changed', () => {
  const now = Date.now()
  if (now - lastChange < 15_000) return
  lastChange = now
  void load()
})
onBeforeUnmount(unsub)

const modelRows = computed(() => {
  const byModel = new Map<string, CostGroup>()
  for (const g of groups.value) {
    const model = g.model ?? ''
    const row = byModel.get(model) ?? {
      key: model, calls: 0, input: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0,
      output: 0, usd: 0, unpriced_calls: 0,
    }
    row.calls += g.calls
    row.input += g.input
    row.cache_read += g.cache_read
    row.cache_write_5m += g.cache_write_5m
    row.cache_write_1h += g.cache_write_1h
    row.output += g.output
    row.usd += g.usd
    row.unpriced_calls += g.unpriced_calls
    byModel.set(model, row)
  }
  return [...byModel.values()].sort((a, b) => groupTokens(b) - groupTokens(a))
})

const stackedModels = computed(() => modelRows.value.slice(0, STACKED).map((r) => r.key))

const bars = computed(() => {
  const perDay = days.value.map((day) => {
    const parts = stackedModels.value.map(() => 0)
    let other = 0
    for (const g of groups.value) {
      if (g.day !== day) continue
      const i = stackedModels.value.indexOf(g.model ?? '')
      if (i >= 0) parts[i] += groupTokens(g)
      else other += groupTokens(g)
    }
    return { day, parts: [...parts, other], total: parts.reduce((a, b) => a + b, 0) + other }
  })
  const max = Math.max(1, ...perDay.map((d) => d.total))
  return perDay.map((d) => ({
    ...d,
    label: d.day.slice(5).replace('-', '/'),
    segments: d.parts.map((n, i) => ({ pct: (n / max) * 100, color: COLORS[i] ?? 'var(--text-muted)' })),
  }))
})

const legend = computed(() => [
  ...stackedModels.value.map((m, i) => ({ label: m || '?', color: COLORS[i], other: false })),
  ...(modelRows.value.length > STACKED ? [{ label: '', color: 'var(--text-muted)', other: true }] : []),
])

function cacheOf(g: CostGroup): number {
  return g.cache_read + g.cache_write_5m + g.cache_write_1h
}
</script>

<template>
  <div class="by-model" data-view="by-model">
    <div v-if="error" class="muted">{{ error }}</div>
    <div v-else-if="!modelRows.length" class="muted" data-part="empty">{{ $t('token-views.no-ledger-data') }}</div>
    <template v-else>
      <div v-if="range === 'week'" class="bars" data-part="bars">
        <div v-for="bar in bars" :key="bar.day" class="bar-row" :data-day="bar.day">
          <span class="bar-day">{{ bar.label }}</span>
          <span class="bar-track">
            <span v-for="(seg, i) in bar.segments" :key="i" class="bar-seg" :style="{ width: seg.pct + '%', background: seg.color }" />
          </span>
          <span class="bar-total">{{ bar.total ? fmtTokens(bar.total) : '—' }}</span>
        </div>
        <div class="legend">
          <span v-for="item in legend" :key="item.label || 'other'" class="legend-item" v-truncate>
            <span class="swatch" :style="{ background: item.color }" />{{ item.other ? $t('token-views.other-models') : item.label }}
          </span>
        </div>
      </div>
      <table class="grid grid-models">
        <tbody>
          <tr v-for="row in modelRows" :key="row.key" data-row="model" :data-model="row.key"
              :title="`${row.calls} · ${$t('token-views.cache-read')} ${fmtTokens(row.cache_read)} · ${$t('token-views.cache-write')} ${fmtTokens(row.cache_write_5m + row.cache_write_1h)}`">
            <th v-truncate>{{ row.key || '?' }}</th>
            <td v-truncate>{{ fmtTokens(row.input) }}</td>
            <td v-truncate>{{ fmtTokens(cacheOf(row)) }}</td>
            <td v-truncate>{{ fmtTokens(row.output) }}</td>
            <td class="usd" data-part="usd" v-truncate>{{ fmtUsd(row) }}</td>
          </tr>
          <tr class="head">
            <th></th><td v-truncate>{{ $t('label.in') }}</td><td v-truncate>{{ $t('token-views.cache') }}</td><td v-truncate>{{ $t('label.out') }}</td><td v-truncate>{{ $t('token-views.usd') }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.muted { color: var(--text-muted); padding: 2px 0; }
.bars { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
.bar-row { display: grid; grid-template-columns: 4ch 1fr 6ch; align-items: center; gap: 6px; }
.bar-day, .bar-total { color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.bar-total { text-align: right; }
.bar-track { display: flex; height: 8px; background: var(--bg-subtle, transparent); border-radius: 2px; overflow: hidden; min-width: 0; }
.bar-seg { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-top: 2px; color: var(--text-muted); }
.legend-item { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.grid { width: 100%; border-collapse: collapse; table-layout: fixed; font-variant-numeric: tabular-nums; }
.grid th, .grid td { padding: 1px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grid th { text-align: left; font-weight: normal; }
.grid td { text-align: right; width: 6ch; }
.grid td.usd { width: 7ch; }
.grid tr.head td { color: var(--text-muted); }
</style>
