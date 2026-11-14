<script setup lang="ts">
// BY ACCOUNT QUOTA: one row per account Navide has quota readings for,
// grouped by vendor. Each row shows the account's windows (live reading when
// the usage badge has one, else the last recorded one) as bars, when the
// weekly window resets, the tokens the ledger recorded on it in the panel's
// day / week range (every workspace), and a 7-day line of the weekly
// window's daily peak. Read-only: nothing here switches or judges accounts.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import type { useCliProfiles } from '../composables/useCliProfiles'
import { accountUsageFor } from '../composables/useUsage'
import { DEFAULT_PROFILE_ID, UNKNOWN_PROFILE_ID, accountLabel } from '../lib/accountLabel'
import {
  fmtTokens, groupTokens, rangeDays, utcOffsetMin, type CostReport, type TokenRange,
} from '../lib/tokenViews'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  range: TokenRange
  cliProfiles?: ReturnType<typeof useCliProfiles>
}>()

interface HistoryWindow {
  window_kind: string
  latest: { used_percent: number; resets_at: number; fetched_at: number }
  peaks: (number | null)[]
}
interface HistoryAccount { agent_key: string; profile_id: string; windows: HistoryWindow[] }
interface QuotaHistory { ok: boolean; error?: string; days: string[]; accounts: HistoryAccount[] }

const WARN_PCT = 70
const CRIT_PCT = 90
const VENDOR_LABELS: Record<string, string> = Object.fromEntries(
  CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label])
)

const history = ref<QuotaHistory | null>(null)
const tokensByAccount = ref<Record<string, number>>({})
const error = ref('')
let sequence = 0

async function load(): Promise<void> {
  if (props.backend.status.value !== 'connected') return
  const current = ++sequence
  const offset = utcOffsetMin()
  const span = rangeDays(props.range)
  const [quota, cost] = await Promise.all([
    props.backend.send<QuotaHistory>('tokens.quota_history', { days: 7, utc_offset_min: offset }),
    props.backend.send<CostReport>('tokens.cost_report', {
      by: 'account', since: span[0], until: span[span.length - 1], utc_offset_min: offset,
    }),
  ])
  if (current !== sequence) return
  if (!quota.ok || !quota.payload?.ok) {
    error.value = quota.payload?.error || quota.error?.message || 'failed'
    return
  }
  error.value = ''
  history.value = quota.payload
  const totals: Record<string, number> = {}
  if (cost.ok && cost.payload?.ok) {
    // The ledger stores an unknown account as ''.
    for (const g of cost.payload.groups) totals[g.key || UNKNOWN_PROFILE_ID] = groupTokens(g)
  }
  tokensByAccount.value = totals
}

watch(() => [props.backend.status.value, props.range] as const, () => void load(), { immediate: true })
let lastChange = 0
function onTokensChanged(): void {
  const now = Date.now()
  if (now - lastChange < 15_000) return
  lastChange = now
  void load()
}
// `tokens.notice` replaces `tokens.changed` on a backend that knows
// tokens.watch. Account quotas span workspaces, so this watches all of them.
const unsub = props.backend.on('tokens.changed', onTokensChanged)
const unsubNotice = props.backend.on('tokens.notice', onTokensChanged)
const releaseWatch = props.backend.watchTokens?.('*')
onBeforeUnmount(() => {
  unsub()
  unsubNotice()
  releaseWatch?.()
})

function windowLabel(kind: string, label?: string): string {
  if (label) return label
  const [base, model] = kind.split(':')
  const t = i18n.global.t
  const name = base === 'session' ? t('token-views.window-session')
    : base.startsWith('weekly') ? t('token-views.window-weekly') : base
  return model ? `${name} (${model})` : name
}

function level(pct: number): '' | 'warn' | 'crit' {
  return pct >= CRIT_PCT ? 'crit' : pct >= WARN_PCT ? 'warn' : ''
}

function fmtReset(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function sparkline(peaks: (number | null)[]): string {
  const w = 56, h = 14
  const step = peaks.length > 1 ? w / (peaks.length - 1) : 0
  return peaks
    .map((p, i) => (p === null ? null : `${(i * step).toFixed(1)},${(h - (p / 100) * h).toFixed(1)}`))
    .filter(Boolean)
    .join(' ')
}

const sections = computed(() => {
  const t = (key: string): string => i18n.global.t(key)
  const byVendor = new Map<string, ReturnType<typeof row>[]>()
  function row(account: HistoryAccount) {
    const id = account.profile_id
    const live = accountUsageFor(account.agent_key, id === DEFAULT_PROFILE_ID ? null : id)
    const liveOk = live?.status === 'ok' && live.windows.length > 0
    const windows = liveOk
      ? live!.windows.filter((w) => !w.expired).map((w) => ({
          key: w.kind + ':' + w.label, label: windowLabel(w.kind, w.label), pct: Math.round(w.usedPercent),
          resetsAt: w.resetsAt ? Date.parse(w.resetsAt) / 1000 : null, weekly: w.kind === 'weekly',
        }))
      : account.windows.map((w) => ({
          key: w.window_kind, label: windowLabel(w.window_kind), pct: Math.round(w.latest.used_percent),
          resetsAt: w.latest.resets_at, weekly: w.window_kind === 'weekly',
        }))
    const weekly = windows.find((w) => w.weekly) ?? windows[0]
    const trend = account.windows.find((w) => w.window_kind === 'weekly') ?? account.windows[0]
    return {
      key: `${account.agent_key}:${id}`,
      id,
      label: accountLabel(props.cliProfiles, account.agent_key, id, t),
      windows,
      reset: fmtReset(weekly?.resetsAt ?? null),
      tokens: tokensByAccount.value[id] ?? 0,
      trend: trend ? sparkline(trend.peaks) : '',
    }
  }
  for (const account of history.value?.accounts ?? []) {
    const rows = byVendor.get(account.agent_key) ?? []
    rows.push(row(account))
    byVendor.set(account.agent_key, rows)
  }
  return [...byVendor.entries()].map(([agentKey, rows]) => ({
    agentKey,
    label: VENDOR_LABELS[agentKey] ?? agentKey,
    rows: rows.sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label)),
  }))
})
</script>

<template>
  <div class="by-quota" data-view="by-account-quota">
    <div v-if="error" class="muted">{{ error }}</div>
    <div v-else-if="!sections.length" class="muted" data-part="empty">{{ $t('token-views.no-quota-history') }}</div>
    <div v-for="section in sections" v-else :key="section.agentKey" class="vendor" :data-vendor="section.agentKey">
      <div class="vendor-name" v-truncate>{{ section.label }}</div>
      <div v-for="row in section.rows" :key="row.key" class="account" data-row="quota-account" :data-account="row.id">
        <div class="account-head">
          <span class="account-name" :title="row.id" v-truncate>{{ row.label }}</span>
          <svg v-if="row.trend" class="trend" viewBox="0 0 56 14" :aria-label="$t('token-views.trend-7d')" role="img">
            <title>{{ $t('token-views.trend-7d') }}</title>
            <polyline :points="row.trend" />
          </svg>
          <span class="account-tokens" data-part="tokens" :title="range === 'week' ? $t('token-views.week-tokens') : $t('token-views.day-tokens')">{{ fmtTokens(row.tokens) }}</span>
        </div>
        <div v-for="w in row.windows" :key="w.key" class="window" :data-window="w.key">
          <span class="window-label" v-truncate>{{ w.label }}</span>
          <span class="window-track"><span class="window-fill" :class="level(w.pct)" :style="{ width: Math.min(100, w.pct) + '%' }" /></span>
          <span class="window-pct" :class="level(w.pct)">{{ w.pct }}%</span>
        </div>
        <div v-if="row.reset" class="reset muted">{{ $t('token-views.resets', { time: row.reset }) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.muted { color: var(--text-muted); }
.vendor + .vendor { margin-top: 6px; }
.vendor-name { color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account { padding: 3px 0; border-top: 1px solid var(--border-muted); }
.account-head { display: grid; grid-template-columns: 1fr auto 6ch; align-items: center; gap: 6px; }
.account-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.account-tokens { text-align: right; font-variant-numeric: tabular-nums; }
.trend { width: 56px; height: 14px; }
.trend polyline { fill: none; stroke: var(--accent-fg); stroke-width: 1.5; }
.window { display: grid; grid-template-columns: minmax(0, 9ch) 1fr 4ch; align-items: center; gap: 6px; margin-top: 2px; }
.window-label { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.window-track { height: 6px; border-radius: 3px; background: var(--border-muted); overflow: hidden; min-width: 0; }
.window-fill { display: block; height: 100%; background: var(--accent-fg); }
.window-fill.warn { background: var(--attention-fg); }
.window-fill.crit { background: var(--danger-fg); }
.window-pct { text-align: right; font-variant-numeric: tabular-nums; }
.window-pct.warn { color: var(--attention-fg); }
.window-pct.crit { color: var(--danger-fg); }
.reset { margin-top: 1px; }
</style>
