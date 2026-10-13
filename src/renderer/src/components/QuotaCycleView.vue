<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import type { useBackend } from '../composables/useBackend'
import type { useCliProfiles } from '../composables/useCliProfiles'
import { useQuotaCycles, type QuotaCycle, type QuotaCursor, type QuotaSnapshot } from '../composables/useQuotaCycles'
import { useAccountPeriods, type AccountPeriodRow, type PeriodGranularity } from '../composables/useAccountPeriods'
import { usageEnabled, refreshUsage, type UsageSnapshot } from '../composables/useUsage'
import { UNKNOWN_PROFILE_ID, accountKey, accountLabel as resolveAccountLabel, accountTint } from '../lib/accountLabel'
import BarsWithLine from './charts/BarsWithLine.vue'
import StackedBars from './charts/StackedBars.vue'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  agentKey: string
  profileId: string
  label: string
  vendorLabel: string
  active: boolean
  usage?: UsageSnapshot
  cliProfiles?: ReturnType<typeof useCliProfiles>
}>()
const emit = defineEmits<{ openSettings: [] }>()
const { t, locale } = useI18n()
type Tab = 'cycle' | 'month' | 'year'
const tab = ref<Tab>('cycle')
const showChart = ref(true)
const allAccounts = ref(false)
const aggregate = computed(() => allAccounts.value && tab.value !== 'cycle')
const windowKind = ref('')
const retainedKinds = ref<string[]>([])
const range = ref('30')
const startDate = ref('')
const endDate = ref('')
const rangeAnchor = ref(Date.now())
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const rangeStart = computed(() => range.value === 'custom' ? (startDate.value ? new Date(startDate.value + 'T00:00:00Z').toISOString() : undefined) : new Date(rangeAnchor.value - Number(range.value) * 86400000).toISOString())
const rangeEnd = computed(() => range.value === 'custom' && endDate.value ? new Date(Date.parse(endDate.value + 'T00:00:00Z') + 86400000).toISOString() : undefined)
const validRange = computed(() => range.value !== 'custom' || (!!rangeStart.value && !!rangeEnd.value && rangeStart.value < rangeEnd.value))
const cyclesApi = useQuotaCycles(props.backend)
const periodsApi = useAccountPeriods(props.backend)
const cursors = ref<Array<QuotaCursor | undefined>>([undefined])
const page = ref(0)
const snapshot = ref<QuotaSnapshot>()
const selectedId = ref<string | null>(null)
const selectedCycle = ref<QuotaCycle | null>(null)
const selectedPeriod = ref<AccountPeriodRow | null>(null)
const selectionNotice = ref(false)
const exporting = ref(false)
const exportError = ref('')
const exportedCount = ref<number | null>(null)
const granularity = computed<PeriodGranularity>(() => tab.value === 'year' ? 'year' : 'month')
const cycles = computed(() => cyclesApi.data.value?.cycles ?? [])
const kindCycles = computed(() => cycles.value.filter((c) => !windowKind.value || c.window_kind === windowKind.value))
const periodRows = computed(() => periodsApi.data.value?.rows ?? [])
const loading = computed(() => tab.value === 'cycle' ? cyclesApi.loading.value : periodsApi.loading.value)
const error = computed(() => tab.value === 'cycle' ? cyclesApi.error.value : periodsApi.error.value)
const visibleCount = computed(() => tab.value === 'cycle' ? kindCycles.value.length : periodRows.value.length)
const totalCount = computed(() => tab.value === 'cycle' ? (cyclesApi.data.value?.total_count ?? kindCycles.value.length) : (periodsApi.data.value?.total_count ?? periodRows.value.length))
const refreshedAt = computed(() => tab.value === 'cycle' ? cyclesApi.data.value?.refreshed_at : periodsApi.data.value?.refreshed_at)
const hasNext = computed(() => tab.value === 'cycle' ? !!cyclesApi.data.value?.next_cursor : periodsApi.data.value?.next_offset != null)
const summary = computed(() => tab.value === 'cycle' ? cyclesApi.data.value?.summary?.[windowKind.value] : periodsApi.data.value?.summary)
const KIND_ORDER = ['session', 'weekly', 'weekly-model', 'monthly', 'cycle']
const baseKind = (kind: string): string => kind.split(':')[0]
const windowKinds = computed(() => {
  const kinds = retainedKinds.value
  const rank = (kind: string): number => { const n = KIND_ORDER.indexOf(baseKind(kind)); return n < 0 ? KIND_ORDER.length : n }
  return [...kinds].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
})
watch(cyclesApi.data, (data) => { if (data) retainedKinds.value = data.window_kinds ?? [...new Set((data.cycles ?? []).map((c) => c.window_kind))] })
function kindLabel(kind: string): string {
  const base = baseKind(kind)
  const suffix = kind.slice(base.length + 1)
  return props.usage?.windows.find((w) => w.kind === base && (!suffix || w.label === suffix))?.label ?? (suffix || kind)
}
watch(windowKinds, (kinds) => { if (!windowKind.value && kinds.length) windowKind.value = kinds[0] })
function num(value: number | null | undefined): string { return value == null ? '—' : value.toLocaleString(locale.value) }
function compact(value: number): string { return new Intl.NumberFormat(locale.value, { notation: 'compact', maximumFractionDigits: 1 }).format(value) }
function stamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Date(value).toLocaleString(locale.value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
}
function known(row: QuotaCycle | AccountPeriodRow): boolean {
  return row.coverage_state ? row.coverage_state === 'available' : row.detail_known === true
}
function amount(row: QuotaCycle | AccountPeriodRow, key: 'input' | 'cache_read' | 'cache_creation' | 'output' | 'total' | 'calls' | 'turns'): number | null {
  return known(row) ? row[key] : null
}
function coverage(row: QuotaCycle | AccountPeriodRow): string { return t('quota-cycles.coverage-' + (row.coverage_state ?? 'unavailable')) }
function reason(row: QuotaCycle | AccountPeriodRow): string { return t('quota-cycles.reason-' + (row.coverage_reason ?? (known(row) ? 'local' : 'legacy_coverage_unknown'))) }
function source(row: QuotaCycle): string { return t('quota-cycles.source-' + (row.exhausted_source ?? (row.exhausted_at ? 'legacy_unknown' : 'none'))) }
function cycleKey(row: QuotaCycle): string { return row.id != null ? String(row.id) : [props.agentKey, props.profileId, row.window_kind, row.resets_at].join('/') }
function periodKey(row: AccountPeriodRow): string { return [row.period, row.agent_key, row.profile_id].join('/') }
function selectCycle(row: QuotaCycle): void {
  selectedId.value = selectedId.value === cycleKey(row) ? null : cycleKey(row)
  selectedCycle.value = selectedId.value ? row : null
  selectedPeriod.value = null
  selectionNotice.value = false
}
function selectPeriod(row: AccountPeriodRow): void {
  selectedId.value = selectedId.value === periodKey(row) ? null : periodKey(row)
  selectedPeriod.value = selectedId.value ? row : null
  selectedCycle.value = null
  selectionNotice.value = false
}
function clearSelection(): void {
  selectionNotice.value = selectedId.value !== null
  selectedId.value = null
  selectedCycle.value = null
  selectedPeriod.value = null
}
watch(cycles, (rows) => {
  if (!selectedCycle.value) return
  const updated = rows.find((c) => cycleKey(c) === selectedId.value)
  if (updated) selectedCycle.value = updated
})
watch(periodRows, (rows) => {
  if (!selectedPeriod.value) return
  const updated = rows.find((r) => periodKey(r) === selectedId.value)
  if (updated) selectedPeriod.value = updated
})
async function load(): Promise<void> {
  if (!validRange.value) return
  if (tab.value === 'cycle') {
    await cyclesApi.load({ agentKey: props.agentKey, profileId: props.profileId, windowKind: windowKind.value,
      rangeStart: rangeStart.value, rangeEnd: rangeEnd.value, cursor: cursors.value[page.value], snapshot: snapshot.value })
  } else {
    await periodsApi.load({ agentKey: aggregate.value ? undefined : props.agentKey, profileId: aggregate.value ? undefined : props.profileId,
      granularity: granularity.value, rangeStart: rangeStart.value, rangeEnd: rangeEnd.value, windowKind: windowKind.value, offset: page.value * 50 })
  }
}
function resetPage(): void { page.value = 0; cursors.value = [undefined]; snapshot.value = undefined }
function refresh(): void { resetPage(); void load() }
function changePage(direction: number): void {
  if (direction > 0 && tab.value === 'cycle') {
    const next = cyclesApi.data.value?.next_cursor
    if (!next) return
    cursors.value[page.value + 1] = next
    snapshot.value = cyclesApi.data.value?.snapshot
  }
  page.value = Math.max(0, page.value + direction)
  void load()
}
watch([() => props.agentKey, () => props.profileId], () => {
  windowKind.value = ''; retainedKinds.value = []; allAccounts.value = false; clearSelection(); resetPage(); cyclesApi.clear(); periodsApi.clear(); void load()
}, { immediate: true })
watch([tab, allAccounts, windowKind, range, startDate, endDate], () => {
  clearSelection(); resetPage(); cyclesApi.clear(); periodsApi.clear(); void load()
})
function clearFilters(): void { range.value = '30'; startDate.value = ''; endDate.value = ''; rangeAnchor.value = Date.now(); windowKind.value = windowKinds.value[0] ?? ''; refresh() }
const currentReading = computed(() => {
  if (aggregate.value || props.profileId === UNKNOWN_PROFILE_ID || props.usage?.status !== 'ok') return null
  const base = baseKind(windowKind.value)
  const suffix = windowKind.value.slice(base.length + 1)
  return props.usage.windows.find((w) => !w.expired && (!windowKind.value || (w.kind === base && (!suffix || w.label === suffix)))) ?? null
})
const readingState = computed(() => !usageEnabled() ? 'disabled' : props.usage?.refreshPending ? 'refreshing' : props.usage?.status === 'error' || props.usage?.refreshStatus === 'error' ? 'error' : props.usage?.stale || props.usage?.staleExpired ? 'stale' : !currentReading.value ? 'unsupported' : 'cached')
const cycleBars = computed(() => [...kindCycles.value].reverse().map((c) => ({ label: stamp(c.started_at ?? c.resets_at), note: coverage(c) + ' · ' + source(c), value: amount(c, 'total'), percent: c.max_percent, exhausted: c.exhausted_at !== null })))
const selectedCycleBar = computed(() => { const index = [...kindCycles.value].reverse().findIndex((c) => cycleKey(c) === selectedId.value); return index < 0 ? null : index })
const rowAccountLabel = (row: AccountPeriodRow): string => resolveAccountLabel(props.cliProfiles, row.agent_key, row.profile_id, t)
const vendors = Object.fromEntries(CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label]))
const periodBars = computed(() => [...periodRows.value].reverse().map((r) => ({ label: r.period + (aggregate.value ? ' · ' + rowAccountLabel(r) : ''), note: coverage(r), segments: [{ key: accountKey(r.agent_key, r.profile_id), label: rowAccountLabel(r), value: amount(r, 'total'), color: accountTint(r.profile_id) }] })))
const selectedPeriodBar = computed(() => { const index = [...periodRows.value].reverse().findIndex((r) => periodKey(r) === selectedId.value); return index < 0 ? null : index })
function share(row: AccountPeriodRow): string {
  const total = periodsApi.data.value?.totals_by_period.find((p) => p.period === row.period)?.total
  const part = amount(row, 'total')
  return total != null && total > 0 && part != null ? Math.round(part / total * 100) + '%' : '—'
}
const details = computed(() => selectedCycle.value ?? selectedPeriod.value)
const breakdown = ['input', 'cache_read', 'cache_creation', 'output', 'total', 'calls', 'turns'] as const
const fieldLabels = { input: 'turn-stats.col-input', cache_read: 'turn-stats.col-cache-read', cache_creation: 'turn-stats.col-cache-write', output: 'turn-stats.col-output', total: 'quota-cycles.local-tokens', calls: 'turn-stats.col-calls', turns: 'quota-cycles.col-turns' }
function csvCell(value: unknown): string { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text }
function csv(rows: unknown[][]): string { return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n' }
function buildCyclesCsv(rows: QuotaCycle[], context = { agentKey: props.agentKey, profileId: props.profileId, label: props.label }): string {
  return csv([
    ['window_kind', 'started_at', 'resets_at', 'closed', 'max_percent', 'exhausted_at', ...breakdown, 'samples', 'schema_version', 'cycle_id', 'agent_key', 'profile_id', 'account', 'exhausted_source', 'coverage_state', 'coverage_reason', 'token_scope', 'bucket_seconds', 'last_sample_at', 'reconciled_at', 'average_eligible', 'display_timezone', 'calendar_timezone'],
    ...rows.map((c) => [c.window_kind, c.started_at, c.resets_at, Number(c.closed), c.max_percent, c.exhausted_at, ...breakdown.map((k) => amount(c, k)), c.samples, 2, c.id, c.agent_key ?? context.agentKey, c.profile_id ?? context.profileId, context.label, c.exhausted_source ?? (c.exhausted_at ? 'legacy_unknown' : ''), c.coverage_state ?? 'unavailable', c.coverage_reason ?? (known(c) ? '' : 'legacy_coverage_unknown'), c.token_scope ?? 'local_account_all_models', c.bucket_seconds ?? 300, c.last_sample_at, c.reconciled_at, c.average_eligible ?? false, localZone, 'UTC'])
  ])
}
function buildPeriodsCsv(rows: AccountPeriodRow[]): string {
  return csv([
    ['period', 'agent_key', 'profile_id', 'account', ...breakdown, 'cycles', 'exhausted', 'avg_total_exhausted', 'weekly_exhausted', 'schema_version', 'period_start', 'period_end', 'coverage_state', 'coverage_reason', 'eligible_count', 'excluded_count', 'calendar_timezone', 'token_time_key', 'cycle_time_key'],
    ...rows.map((r) => [r.period, r.agent_key, r.profile_id, rowAccountLabel(r), ...breakdown.map((k) => amount(r, k)), r.cycles, r.exhausted, r.avg_total_exhausted, r.weekly_exhausted, 2, r.period_start, r.period_end, r.coverage_state ?? 'unavailable', r.coverage_reason, r.eligible_count, r.excluded_count, 'UTC', 'event_time', 'started_at_or_resets_at'])
  ])
}
async function exportCsv(): Promise<void> {
  exporting.value = true; exportError.value = ''; exportedCount.value = null
  const kind = tab.value
  const context = { agentKey: props.agentKey, profileId: props.profileId, label: props.label }
  try {
    const rows = kind === 'cycle' ? await cyclesApi.exportAll() : await periodsApi.exportAll()
    const text = kind === 'cycle' ? buildCyclesCsv(rows as QuotaCycle[], context) : buildPeriodsCsv(rows as AccountPeriodRow[])
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = 'quota-' + kind + '.csv'; a.click(); URL.revokeObjectURL(url)
    if (props.agentKey === context.agentKey && props.profileId === context.profileId && tab.value === kind) exportedCount.value = rows.length
  } catch (err) { exportError.value = String((err as Error).message ?? err) }
  finally { exporting.value = false }
}
defineExpose({ buildCyclesCsv, buildPeriodsCsv })
</script>

<template>
  <div class="qc-view" data-part="quota-cycles">
    <div class="qc-toolbar">
      <strong class="qc-account" v-truncate data-part="account-name">{{ aggregate ? t('quota-cycles.all-accounts') : label }}</strong>
      <span v-if="!aggregate" data-part="vendor">{{ vendorLabel }}</span>
      <span v-if="!aggregate && profileId !== UNKNOWN_PROFILE_ID" class="qc-active" data-part="active">{{ t(active ? 'account-dim.active' : 'account-dim.inactive') }}</span>
      <span class="qc-spacer" />
      <button type="button" class="qc-ghost" data-act="refresh" @click="refresh">{{ t('quota-cycles.retry-history') }}</button>
      <button type="button" class="qc-ghost" data-act="export" :disabled="!totalCount || exporting || !validRange || loading" @click="exportCsv">{{ t('quota-cycles.export-range') }}</button>
    </div>
    <p class="qc-scope">{{ t('quota-cycles.local-scope', { zone: localZone }) }}</p>
    <div class="qc-summary">
      <div v-if="!aggregate" data-part="current-reading">
        {{ t('quota-cycles.latest-reading') }}: <strong>{{ currentReading ? num(currentReading.usedPercent) + '%' : '—' }}</strong>
        <span>{{ currentReading?.label }} · {{ t('quota-cycles.reading-' + readingState) }}</span>
        <span v-if="usage?.fetchedAt" data-part="as-of"> · {{ stamp(usage.lastSuccessAt ?? usage.fetchedAt) }}</span>
        <span v-if="currentReading?.resetsAt"> · {{ t('quota-cycles.next-reset') }} {{ stamp(currentReading.resetsAt) }}</span>
        <button v-if="readingState === 'disabled'" type="button" class="qc-ghost" data-act="polling-settings" @click="emit('openSettings')">{{ t('quota-cycles.polling-settings') }}</button>
        <button v-else-if="usage && ['stale', 'error'].includes(readingState)" type="button" class="qc-ghost" data-act="retry-provider" @click="refreshUsage(agentKey, profileId)">{{ t('quota-cycles.retry-provider') }}</button>
      </div>
      <div data-part="cycle-summary">{{ t('quota-cycles.range-count', { count: totalCount }) }}<span v-if="refreshedAt"> · {{ t('quota-cycles.history-read') }} {{ stamp(refreshedAt) }}</span></div>
      <div v-if="summary" data-part="average">{{ t('quota-cycles.trusted-average') }}: {{ num(summary.avg_total_exhausted) }} · {{ t('quota-cycles.eligibility', { eligible: summary.eligible_count ?? 0, excluded: summary.excluded_count ?? 0 }) }}</div>
    </div>
    <div class="qc-tabs" role="tablist" :aria-label="t('quota-cycles.account-quota')">
      <button v-for="name in (['cycle', 'month', 'year'] as Tab[])" :key="name" type="button" role="tab" class="qc-tab" data-act="tab" :data-tab="name" :class="{ on: tab === name }" :aria-selected="tab === name" @click="tab = name">{{ t('quota-cycles.tab-' + name) }}</button>
      <button v-if="tab !== 'cycle'" type="button" class="qc-chip" data-act="all-accounts" :data-on="allAccounts" :aria-pressed="allAccounts" @click="allAccounts = !allAccounts">{{ t('quota-cycles.all-accounts') }}</button>
    </div>
    <div class="qc-tabs">
      <button v-for="kind in windowKinds" :key="kind" type="button" class="qc-chip" data-act="window-chip" :data-kind="kind" :class="{ on: windowKind === kind }" :aria-pressed="windowKind === kind" @click="windowKind = kind">{{ kindLabel(kind) }}</button>
      <label>{{ t('quota-cycles.range') }} <select v-model="range" data-act="range"><option value="30">{{ t('quota-cycles.last30') }}</option><option value="90">{{ t('quota-cycles.last90') }}</option><option value="custom">{{ t('quota-cycles.custom') }}</option></select></label>
      <template v-if="range === 'custom'"><label>{{ t('quota-cycles.from') }} <input v-model="startDate" type="date" data-act="from"></label><label>{{ t('quota-cycles.to') }} <input v-model="endDate" type="date" data-act="to"></label></template>
    </div>
    <p class="qc-scope">{{ t(tab === 'cycle' ? 'quota-cycles.cycle-membership' : 'quota-cycles.period-membership') }}</p>
    <p v-if="tab !== 'cycle' && periodsApi.data.value?.effective_range_start" class="qc-scope">{{ periodsApi.data.value.effective_range_start }} → {{ periodsApi.data.value.effective_range_end }} · UTC</p>
    <div v-if="!validRange" class="qc-empty" data-state="invalid-range">{{ t('quota-cycles.invalid-range') }}</div>
    <div v-else class="qc-body">
      <p v-if="loading && !visibleCount" class="qc-empty" data-state="loading">{{ t('turn-stats.scanning') }}</p>
      <p v-if="error" class="qc-empty qc-error" role="alert" data-state="error">{{ t('quota-cycles.error-generic', { detail: error }) }} {{ visibleCount ? t('quota-cycles.retained') : '' }} <button type="button" class="qc-ghost" data-act="retry" @click="load">{{ t('quota-cycles.retry-history') }}</button></p>
      <p v-if="!loading && !error && !visibleCount" class="qc-empty" data-state="empty">{{ t(tab !== 'cycle' || retainedKinds.length ? 'quota-cycles.filtered-empty' : 'quota-cycles.empty') }} <template v-if="!retainedKinds.length">{{ t('quota-cycles.no-reconstruction') }}</template> <button type="button" class="qc-ghost" data-act="clear-filters" @click="clearFilters">{{ t('quota-cycles.clear-filters') }}</button></p>
      <div v-if="visibleCount" class="qc-chart" :data-part="tab === 'cycle' ? 'cycle-chart' : 'period-chart'">
        <button type="button" class="qc-chart-toggle" data-act="toggle-chart" :aria-expanded="showChart" @click="showChart = !showChart">{{ t('quota-cycles.visible-chart') }}</button>
        <p class="qc-hint">{{ t('quota-cycles.chart-cycles-hint') }}</p>
        <BarsWithLine v-if="showChart && tab === 'cycle'" :bars="cycleBars" :selected="selectedCycleBar" :value-format="compact" :ariaLabel="t('quota-cycles.chart-cycles')" :empty-text="t('quota-cycles.empty')" @select="selectCycle([...kindCycles].reverse()[$event])" />
        <StackedBars v-else-if="showChart" :bars="periodBars" :selected="selectedPeriodBar" :value-format="compact" :ariaLabel="t('quota-cycles.chart-' + tab)" :empty-text="t('quota-cycles.empty')" @select="selectPeriod([...periodRows].reverse()[$event])" />
      </div>
      <table v-if="visibleCount && tab === 'cycle'" class="qc-table" data-state="table">
        <thead><tr><th>{{ t('quota-cycles.col-cycle') }}</th><th>{{ t('quota-cycles.state-evidence') }}</th><th>{{ t('quota-cycles.col-max') }}</th><th>{{ t('quota-cycles.local-tokens') }}</th><th>{{ t('quota-cycles.col-exhausted') }}</th></tr></thead>
        <tbody><tr v-for="c in kindCycles" :key="cycleKey(c)" class="qc-row" data-row="cycle" :data-selected="selectedId === cycleKey(c)" :data-no-detail="!known(c)">
          <td data-part="cycle"><button type="button" class="qc-row-button" data-act="details" :aria-expanded="selectedId === cycleKey(c)" aria-controls="quota-selected-detail" @click="selectCycle(c)">{{ stamp(c.started_at) }} → {{ stamp(c.resets_at) }}</button></td>
          <td>{{ t(c.closed ? 'quota-cycles.ended' : 'quota-cycles.in-progress') }} · {{ source(c) }}<small>{{ coverage(c) }}</small></td>
          <td data-part="max">{{ num(c.max_percent) }}%</td><td data-part="total">{{ known(c) ? '≈ ' : '' }}{{ num(amount(c, 'total')) }}</td><td data-part="exhausted">{{ stamp(c.exhausted_at) }}<small v-if="c.exhausted_at && (!c.exhausted_source || c.exhausted_source === 'legacy_unknown')">{{ t('quota-cycles.unverified') }}</small></td>
        </tr></tbody>
      </table>
      <table v-if="visibleCount && tab !== 'cycle'" class="qc-table" data-state="table" :data-mode="aggregate ? 'all' : 'single'">
        <thead><tr><th>{{ t('quota-cycles.col-' + tab) }} · UTC</th><th v-if="aggregate">{{ t('quota-cycles.col-account') }}</th><th>{{ t('quota-cycles.local-tokens') }}</th><th v-if="aggregate">{{ t('quota-cycles.col-share') }}</th><th>{{ t('quota-cycles.col-cycles') }}</th><th>{{ t('quota-cycles.trusted-average') }}</th></tr></thead>
        <tbody><tr v-for="r in periodRows" :key="periodKey(r)" class="qc-row" :data-row="aggregate ? 'period-account' : 'period'" :data-period="r.period" :data-selected="selectedId === periodKey(r)">
          <td><button type="button" class="qc-row-button" data-act="details" :aria-expanded="selectedId === periodKey(r)" aria-controls="quota-selected-detail" @click="selectPeriod(r)">{{ r.period }}</button></td><td v-if="aggregate">{{ rowAccountLabel(r) }} · {{ vendors[r.agent_key] ?? r.agent_key }}</td><td data-part="total">{{ num(amount(r, 'total')) }}<small>{{ coverage(r) }}</small></td><td v-if="aggregate" data-part="share">{{ share(r) }}</td><td>{{ num(r.cycles) }}</td><td data-part="avg-exhausted">{{ num(r.avg_total_exhausted) }}<small>{{ t('quota-cycles.eligibility', { eligible: r.eligible_count ?? 0, excluded: r.excluded_count ?? 0 }) }}</small></td>
        </tr></tbody>
      </table>
      <p v-if="selectionNotice" role="status" class="qc-scope">{{ t('quota-cycles.selection-cleared') }}</p>
      <section v-if="details" id="quota-selected-detail" class="qc-detail" data-part="selected-detail" :aria-label="t('quota-cycles.details')">
        <h3>{{ t('quota-cycles.details') }}</h3><p>{{ coverage(details) }} · {{ reason(details) }}</p>
        <p>{{ t('quota-cycles.local-scope', { zone: localZone }) }}</p>
        <dl><template v-for="key in breakdown" :key="key"><dt>{{ t(fieldLabels[key]) }}</dt><dd :data-part="key">{{ num(amount(details, key)) }}</dd></template></dl>
        <template v-if="selectedCycle">
          <p>{{ source(selectedCycle) }} · {{ t('quota-cycles.col-exhausted') }}: {{ stamp(selectedCycle.exhausted_at) }} ({{ selectedCycle.exhausted_at ?? '—' }})</p>
          <p>{{ t('quota-cycles.col-cycle') }}: {{ selectedCycle.started_at ?? '—' }} → {{ selectedCycle.resets_at }} · UTC</p>
          <p>{{ t('quota-cycles.changed-readings') }}: {{ selectedCycle.samples }} · {{ t('quota-cycles.latest-reading') }}: {{ stamp(selectedCycle.last_sample_at) }}</p>
          <p>{{ t('quota-cycles.reconciled') }}: {{ stamp(selectedCycle.reconciled_at) }}</p>
          <p>{{ t('quota-cycles.per-point') }}: {{ known(selectedCycle) && selectedCycle.total !== null && selectedCycle.max_percent > 0 ? num(selectedCycle.total / selectedCycle.max_percent) : '—' }}. {{ t('quota-cycles.formula') }}</p>
        </template>
        <p v-if="selectedPeriod">{{ selectedPeriod.period_start }} → {{ selectedPeriod.period_end }} · UTC</p>
        <p v-if="!known(details) && details.recorded_totals">{{ t('quota-cycles.recorded-subtotal') }}: {{ num(details.recorded_totals.total) }}</p>
        <p>{{ t('quota-cycles.note') }}</p>
      </section>
    </div>
    <div class="qc-foot">
      <span>{{ t('quota-cycles.page-count', { count: visibleCount, total: totalCount, page: page + 1 }) }}</span>
      <button type="button" class="qc-ghost" data-act="previous" :disabled="page === 0 || loading" @click="changePage(-1)">{{ t('quota-cycles.previous') }}</button><button type="button" class="qc-ghost" data-act="next" :disabled="!hasNext || loading" @click="changePage(1)">{{ t('quota-cycles.next') }}</button>
    </div>
    <p class="qc-scope">{{ t('quota-cycles.export-scope') }} <span v-if="exportedCount !== null" role="status">{{ t('quota-cycles.exported', { count: exportedCount }) }}</span><span v-if="exportError" role="alert">{{ exportError === 'range-too-large' ? t('quota-cycles.export-too-large') : t('quota-cycles.error-generic', { detail: exportError }) }}</span></p>
  </div>
</template>

<style scoped>
.qc-view {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  overflow: hidden;
}
.qc-scope { margin: 0; padding: 6px 16px; color: var(--text-muted); font-size: var(--font-2xs); }
.qc-summary { display: grid; gap: 8px; }
.qc-summary span { font-size: var(--font-2xs); font-weight: 400; }
.qc-toolbar, .qc-foot { flex-wrap: wrap; }
.qc-row-button { border: 0; background: transparent; color: var(--accent-fg); text-align: left; font: inherit; cursor: pointer; padding: 4px 0; }
.qc-view button:focus-visible, .qc-view input:focus-visible, .qc-view select:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.qc-tabs input, .qc-tabs select { font: inherit; color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: var(--radius-sm); padding: 4px; }
.qc-table td { white-space: normal; }
.qc-table small { display: block; color: var(--text-muted); margin-top: 4px; }
.qc-detail { margin: 16px; padding: 16px; border: 1px solid var(--border-muted); background: var(--bg-subtle); border-radius: var(--radius-md); overflow-wrap: anywhere; }
.qc-detail h3 { margin: 0 0 8px; color: var(--text-bright); }
.qc-detail dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr) auto); gap: 6px 16px; }
.qc-detail dd { margin: 0; font-variant-numeric: tabular-nums; }
@media (max-width: 800px) { .qc-detail dl { grid-template-columns: minmax(0, 1fr) auto; } .qc-account { max-width: 100%; } }
.qc-spacer { flex: 1; }

.qc-toolbar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.qc-account {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-sm);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qc-vendor { color: var(--text-muted); }
.qc-active {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.qc-active.on {
  color: var(--success-fg);
  border-color: var(--success-muted);
  background: var(--success-subtle);
}
.qc-asof { font-size: var(--font-3xs); color: var(--text-muted); }
.qc-ghost {
  padding: 4px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.qc-ghost:hover { color: var(--text-bright); }
.qc-ghost:disabled { color: var(--text-disabled); cursor: default; }

.qc-tabs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.qc-tab {
  padding: 4px 10px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  cursor: pointer;
}
.qc-tab:hover { color: var(--text-bright); }
.qc-tab.on { color: var(--accent-fg); border-bottom-color: var(--accent-emphasis); }
.qc-chip {
  padding: 2px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  white-space: nowrap;
}
.qc-chip:hover { color: var(--text-bright); border-color: var(--border-default); }
.qc-chip.on {
  background: var(--accent-subtle);
  border-color: var(--accent-muted);
  color: var(--accent-fg);
}

.qc-summary {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-sm);
  font-variant-numeric: tabular-nums;
}

.qc-chart {
  padding: 6px 16px;
  border-bottom: 1px solid var(--border-muted);
}
.qc-chart-toggle {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.qc-chart-toggle:hover { color: var(--text-bright); }
.qc-caret { color: var(--text-muted); }
.qc-hint { color: var(--text-muted); font-weight: 400; font-size: var(--font-3xs); }

.qc-body {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
}
.qc-empty {
  margin: 0;
  padding: 24px 16px;
  color: var(--text-muted);
  text-align: center;
}
.qc-error { color: var(--attention-fg); }

.qc-table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.qc-table th,
.qc-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-muted);
  white-space: nowrap;
}
.qc-table th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-weight: 400;
  font-size: var(--font-3xs);
  text-align: left;
}
.qc-table th:first-child,
.qc-table td:first-child { padding-left: 16px; }
.qc-table th:last-child,
.qc-table td:last-child { padding-right: 16px; }
.qc-table td { white-space: normal; }
.c-period { color: var(--text-primary); }
.c-when { width: 7ch; color: var(--text-muted); }
.qc-table th.c-num,
.qc-table td.c-num { text-align: right; }
.c-total { color: var(--text-bright); font-weight: 600; }
.qc-row { cursor: pointer; }
.qc-row:hover { background: var(--bg-hover-faint); }
.qc-row[data-selected='true'] { background: var(--bg-selected); }
.qc-row[data-exhausted='true'] .c-when { color: var(--danger-fg); font-weight: 600; }
.qc-open {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-3xs);
}
.qc-nodetail {
  margin-left: 6px;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  font-style: italic;
}
.qc-row[data-no-detail='true'] .c-num { color: var(--text-muted); }
.qc-avg td {
  border-top: 1px solid var(--border-default);
  border-bottom: 0;
  color: var(--text-bright);
  font-weight: 600;
  background: var(--bg-subtle);
}
.qc-period-head td {
  background: var(--bg-subtle);
  color: var(--text-bright);
  font-weight: 600;
}
.qc-period-head[data-selected='true'] td { background: var(--bg-selected); }
.qc-account-row .c-account { padding-left: 28px; }
.qc-account-row.unknown .c-account { color: var(--text-muted); font-style: italic; }
.qc-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 2px;
  vertical-align: middle;
}
.qc-vendor-sub { color: var(--text-muted); font-size: var(--font-3xs); }

.qc-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.qc-foot-note { line-height: 1.45; }
</style>
