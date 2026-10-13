<script setup lang="ts">
// Turn Stats view: one CLI pane's token usage cut per turn (a prompt sent →
// the CLI done replying), with a total at the bottom. The right half of the
// Turn Stats modal; the host picks the pane and passes it in, along with the
// quota snapshot the pane's usage badge reads, so the figures and the quota
// sit side by side.
//
// It owns no pane state: the figures come from the backend's on-demand
// transcript scan (`tokens.turns`). Nothing here is accumulated — every pick
// or rescan re-reads the transcript, which is why an old session still adds
// up as long as its file exists.
import { computed, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import type { useCliProfiles } from '../composables/useCliProfiles'
import { useTokenTurns, type TokenTurn, type TurnMethod } from '../composables/useTokenTurns'
import { accountUsageFor, exhaustedWindow, formatResetAbsolute, type UsageSnapshot } from '../composables/useUsage'
import {
  DEFAULT_PROFILE_ID,
  UNKNOWN_PROFILE_ID,
  accountLabel as resolveAccountLabel,
  accountRemoved,
  normalizeProfileId,
} from '../lib/accountLabel'
import HBars from './charts/HBars.vue'

/** What the view needs to know about the pane it is showing. */
export interface TurnStatsPane {
  id: string
  agentKey: string
  /** Display name (custom or auto name, falling back to the vendor label). */
  agentLabel: string
  /** 'waiting' is a cold-restore placeholder — listed, since its transcript
   *  is still on disk and the backend can resolve it by session id. */
  status: string
  sessionId?: string
  workspacePath?: string
  /** The pane's last quota hit (see ActivePane): when the CLI's limit message
   *  was seen, when the quota is due back, and the never-cleared detection
   *  mark. Only the most recent hit exists — the pane keeps one set. */
  usageLimitAt?: number | null
  usageLimitUntil?: number | null
  usageLimitSeenAt?: number | null
  /** The account the pane is pinned to ('__default__' = real home). */
  profileId?: string
}

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  /** The pane to show; null when there is none to pick. */
  pane: TurnStatsPane | null
  /** The quota snapshot for the pane's agent — the same one its usage badge
   *  reads (per agent, not per pane). Undefined when the agent has none. It
   *  stands in for the active account's reading when the backend reports no
   *  accounts on the session (or has no per-account snapshot yet). */
  usage?: UsageSnapshot
  /** The accounts source the usage badge's switch list reads; resolves each
   *  turn's profile id to a name and says which account is active. Optional
   *  so a host without accounts still gets the table (ids shown raw). */
  cliProfiles?: ReturnType<typeof useCliProfiles>
}>()

const { t } = useI18n()

// Vendors whose transcripts carry no token usage at all (protobuf blobs the
// reader cannot read). Answered locally rather than asking the backend to
// open the file.
const NO_TOKEN_VENDORS = new Set(['antigravity', 'cursor'])
function vendorUnsupported(agentKey: string): boolean {
  return NO_TOKEN_VENDORS.has(agentKey)
}
/** A placeholder that was never started has no transcript to read; the
 *  backend would say "no-session", but this is known before asking. */
function neverStarted(p: TurnStatsPane): boolean {
  return p.status === 'waiting' && !p.sessionId
}

// ── The scan ────────────────────────────────────────────────────────────────
const turnsApi = useTokenTurns(props.backend)
const expanded = ref(new Set<number>())
/** '' = every account. Cleared on every rescan: it names accounts of the
 *  session it was set on. */
const accountFilter = ref('')
/** '' = every version; set by clicking a bar of the version chart. */
const versionFilter = ref('')

function rescan(): void {
  expanded.value = new Set()
  accountFilter.value = ''
  versionFilter.value = ''
  // Drop the previous answer first: figures for the pane the user just left
  // must not sit under the new pane's name while the scan runs.
  turnsApi.clear()
  const pane = props.pane
  if (!pane || vendorUnsupported(pane.agentKey) || neverStarted(pane)) return
  // Session id and agent key go along with the pane id: a placeholder's pane
  // is not in the backend's live-scan registry, and the bare-session path
  // needs both to find the transcript and pick the reader. Calls come along
  // on the first request so expanding a row never waits on a second scan.
  void turnsApi.load({ paneId: pane.id, sessionId: pane.sessionId, agentKey: pane.agentKey }, { includeCalls: true })
}

// The scan follows the pick. Keyed on id, session and vendor rather than the
// object: the host rebuilds its pane views every 400ms, and a fresh object for
// the same pane must not rescan.
watch(
  [() => props.pane?.id ?? '', () => props.pane?.sessionId ?? '', () => props.pane?.agentKey ?? ''],
  () => rescan(),
  { immediate: true }
)

// ── Rows ────────────────────────────────────────────────────────────────────
const result = computed(() => turnsApi.data.value)
const method = computed<TurnMethod | ''>(() => result.value?.method ?? '')

// ── The account dimension ───────────────────────────────────────────────────
// Every turn carries the profile id the pane was pinned to when it started;
// the name comes from the profiles source, never from the backend.
function turnAccount(r: TokenTurn): string {
  return normalizeProfileId(r.profile_id)
}
function accountLabel(profileId: string | null | undefined): string {
  return resolveAccountLabel(props.cliProfiles, props.pane?.agentKey ?? '', profileId, t)
}
/** The profile id whose credentials the agent is running on right now. */
const activeProfileId = computed(() => {
  const agent = props.pane?.agentKey
  if (!agent || !props.cliProfiles) return DEFAULT_PROFILE_ID
  return props.cliProfiles.defaultProfileId(agent) ?? DEFAULT_PROFILE_ID
})
/** Accounts this session touched, first seen first, unknown last. The
 *  backend lists them; a backend without the dimension gives none, and the
 *  turns are read as a fallback so a partial answer still sorts. */
const accounts = computed<{ id: string; turns: number }[]>(() => {
  const res = result.value
  if (!res) return []
  const counts = new Map<string, number>()
  for (const id of res.accounts ?? []) counts.set(normalizeProfileId(id), 0)
  for (const turn of res.turns) {
    if (turn.profile_id === undefined) continue
    const id = turnAccount(turn)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const list = [...counts.entries()].map(([id, turns]) => ({ id, turns }))
  const unknown = list.filter((a) => a.id === UNKNOWN_PROFILE_ID)
  return [...list.filter((a) => a.id !== UNKNOWN_PROFILE_ID), ...unknown]
})
/** True once the answer carries the dimension at all (a legacy backend does
 *  not, and then the account column and chips would only say "unknown"). */
const hasAccounts = computed(() => accounts.value.length > 0)

const filteredTurns = computed<TokenTurn[]>(() => {
  const turns = result.value?.turns ?? []
  return turns.filter(
    (r) =>
      (!accountFilter.value || turnAccount(r) === accountFilter.value) &&
      (!versionFilter.value || (r.cli_version ?? '') === versionFilter.value)
  )
})
/** Newest first: the turn just finished is the one the user came to check. */
const rows = computed<TokenTurn[]>(() => [...filteredTurns.value].reverse())

type Sum = { input: number; cache_read: number; cache_creation: number; output: number; total: number; calls: number; turns: number }
function emptySum(): Sum {
  return { input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0, turns: 0 }
}
function addTurn(sum: Sum, turn: TokenTurn): void {
  sum.input += turn.input
  sum.cache_read += turn.cache_read
  sum.cache_creation += turn.cache_creation
  sum.output += turn.output
  sum.total += turn.total
  sum.calls += turn.calls
  sum.turns += 1
}
function sumTurns(turns: TokenTurn[]): Sum {
  const sum = emptySum()
  for (const turn of turns) addTurn(sum, turn)
  return sum
}
/** The backend's own totals while nothing is filtered out; otherwise what
 *  is on screen adds up to. */
const visibleTotals = computed<Sum>(() => {
  const res = result.value
  if (!res) return emptySum()
  if (!accountFilter.value && !versionFilter.value) return { ...res.totals, turns: res.turns.length }
  return sumTurns(filteredTurns.value)
})
/** One subtotal per account, shown only while every account is on screen
 *  and there is more than one — a single account's subtotal is the total. */
const subtotals = computed(() => {
  if (accountFilter.value || accounts.value.length < 2) return []
  const byAccount = new Map<string, Sum>()
  for (const turn of filteredTurns.value) {
    const id = turnAccount(turn)
    const sum = byAccount.get(id) ?? emptySum()
    addTurn(sum, turn)
    byAccount.set(id, sum)
  }
  return accounts.value
    .filter((a) => byAccount.has(a.id))
    .map((a) => ({ id: a.id, label: accountLabel(a.id), sum: byAccount.get(a.id)! }))
})

// ── The version dimension ───────────────────────────────────────────────────
const showVersion = ref(true)
const showVersionChart = ref(false)
/** Observed token averages for all recorded turns in this session, by version.
 *  Sample populations differ; these figures do not establish price changes. */
const versionRows = computed(() => {
  const groups = new Map<string, Sum>()
  for (const turn of result.value?.turns ?? []) {
    const v = turn.cli_version ?? ''
    if (!v) continue
    const sum = groups.get(v) ?? emptySum()
    addTurn(sum, turn)
    groups.set(v, sum)
  }
  const collator = new Intl.Collator('en', { numeric: true })
  return [...groups.entries()]
    .sort(([a], [b]) => collator.compare(a, b))
    .map(([version, sum]) => ({
      version,
      turns: sum.turns,
      avgTotal: Math.round(sum.total / sum.turns),
      avgInput: Math.round(sum.input / sum.turns),
      avgCacheRead: Math.round(sum.cache_read / sum.turns),
      avgCacheWrite: Math.round(sum.cache_creation / sum.turns),
      avgOutput: Math.round(sum.output / sum.turns),
    }))
})
const versionBars = computed(() =>
  versionRows.value.map((v) => ({
    label: v.version,
    value: v.avgTotal,
    sub: t('turn-stats.version-samples', { turns: num(v.turns) }),
    title:
      `${v.version}: ${num(v.avgTotal)} (${t('turn-stats.col-input')} ${num(v.avgInput)} · ` +
      `${t('turn-stats.col-cache-read')} ${num(v.avgCacheRead)} · ${t('turn-stats.col-cache-write')} ${num(v.avgCacheWrite)} · ` +
      `${t('turn-stats.col-output')} ${num(v.avgOutput)}) · ${t('turn-stats.version-samples', { turns: num(v.turns) })}`,
  }))
)
const selectedVersionIndex = computed(() => {
  const i = versionRows.value.findIndex((v) => v.version === versionFilter.value)
  return i === -1 ? null : i
})
function onVersionSelect(index: number): void {
  const version = versionRows.value[index]?.version ?? ''
  versionFilter.value = versionFilter.value === version ? '' : version
}
const columnCount = computed(() => 9 + (hasAccounts.value ? 1 : 0) + (showVersion.value ? 1 : 0))

type Panel = 'no-panes' | 'never-started' | 'unsupported' | 'loading' | 'error' | 'empty' | 'table'
const panel = computed<Panel>(() => {
  const pane = props.pane
  if (!pane) return 'no-panes'
  if (vendorUnsupported(pane.agentKey)) return 'unsupported'
  if (neverStarted(pane)) return 'never-started'
  if (turnsApi.loading.value && !result.value) return 'loading'
  if (turnsApi.error.value) return 'error'
  if (!result.value || result.value.method === 'unsupported') return 'unsupported'
  if (result.value.turns.length === 0) return 'empty'
  return 'table'
})

const KNOWN_ERRORS = new Set(['no-session', 'file-missing', 'unknown-vendor', 'scan-failed'])
const errorText = computed(() => {
  const code = turnsApi.error.value
  if (KNOWN_ERRORS.has(code)) return t(`turn-stats.error-${code}`)
  return t('turn-stats.error-generic', { detail: turnsApi.errorDetail.value || code })
})

function toggle(turnIndex: number): void {
  const next = new Set(expanded.value)
  if (next.has(turnIndex)) next.delete(turnIndex)
  else next.add(turnIndex)
  expanded.value = next
}

// ── Quota ───────────────────────────────────────────────────────────────────
// One row per account the session touched, each reading its own snapshot —
// the same per-slot reading the badge's switch list shows — so a session
// that was resumed on another account shows both accounts' windows. A
// backend that reports no accounts falls back to one row on the agent's
// snapshot, the way it read before the dimension existed.
interface QuotaWindowRow {
  kind: string
  label: string
  usedPercent: number
  resetsAt: string | null
  exhausted: boolean
}
/** The general windows the badge reads (per-model promo buckets included,
 *  they are labelled by the provider); the spent one is flagged the way the
 *  badge flags it. Expired windows are a cached snapshot's past and skipped. */
function windowsOf(snap: UsageSnapshot | undefined): QuotaWindowRow[] {
  if (!snap || snap.status !== 'ok') return []
  const spent = exhaustedWindow(snap)
  return snap.windows
    .filter((w) => !w.expired)
    .map((w) => ({ kind: w.kind, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, exhausted: w === spent }))
}

/** A session window is a fixed 5 hours for these vendors (the backend's
 *  quota_windows table), so its start is resetsAt − 5h — the vendors where
 *  "what did this window cost me" can be answered. The snapshot carries
 *  only resetsAt; nobody reports a window's start. */
const SESSION_WINDOW_MS: Record<string, number> = Object.fromEntries(
  ['claude', 'codex', 'kimi', 'opencode', 'qwen', 'antigravity', 'pi'].map((k) => [k, 5 * 60 * 60 * 1000])
)
type WindowSpend = Sum & { start: string; end: string; lastTurnAt: string | null }
function windowSpendOf(turns: TokenTurn[], windows: QuotaWindowRow[]): WindowSpend | null {
  if (turns.length === 0) return null
  const windowMs = SESSION_WINDOW_MS[props.pane?.agentKey ?? '']
  if (!windowMs) return null
  const session = windows.find((w) => w.kind === 'session' && w.resetsAt)
  if (!session) return null
  const end = Date.parse(session.resetsAt as string)
  if (!Number.isFinite(end)) return null
  const start = end - windowMs
  const sum = emptySum()
  for (const turn of turns) {
    const at = turn.started_at ? Date.parse(turn.started_at) : NaN
    if (!Number.isFinite(at) || at < start || at >= end) continue
    addTurn(sum, turn)
  }
  return { ...sum, start: new Date(start).toISOString(), end: session.resetsAt as string, lastTurnAt: turns[turns.length - 1].started_at }
}

interface QuotaAccountRow {
  id: string
  label: string
  /** null = the legacy single row (no account dimension to speak of). */
  active: boolean | null
  unknown: boolean
  removed: boolean
  snapshot: UsageSnapshot | undefined
  windows: QuotaWindowRow[]
  stale: boolean
  /** The snapshot's own clock, so a stale reading says how old it is. */
  asOf: string | null
  spend: WindowSpend | null
}
function snapshotFor(id: string): UsageSnapshot | undefined {
  const agent = props.pane?.agentKey
  const own = accountUsageFor(agent, id === DEFAULT_PROFILE_ID ? null : id)
  if (own) return own
  // The agent-level snapshot is the active account's reading.
  return id === activeProfileId.value ? props.usage : undefined
}
const quotaRows = computed<QuotaAccountRow[]>(() => {
  const res = result.value
  const turns = res?.turns ?? []
  if (!hasAccounts.value) {
    const windows = windowsOf(props.usage)
    return [{
      id: '', label: '', active: null, unknown: false, removed: false, snapshot: props.usage, windows,
      stale: props.usage?.stale === true, asOf: props.usage?.fetchedAt ?? null, spend: windowSpendOf(turns, windows),
    }]
  }
  return accounts.value
    .filter((a) => !accountFilter.value || a.id === accountFilter.value)
    .map((a) => {
      if (a.id === UNKNOWN_PROFILE_ID) {
        return { id: a.id, label: accountLabel(a.id), active: false, unknown: true, removed: false, snapshot: undefined, windows: [], stale: false, asOf: null, spend: null }
      }
      const snapshot = snapshotFor(a.id)
      const windows = windowsOf(snapshot)
      return {
        id: a.id,
        label: accountLabel(a.id),
        active: a.id === activeProfileId.value,
        unknown: false,
        removed: accountRemoved(props.cliProfiles, a.id),
        snapshot,
        windows,
        stale: snapshot?.stale === true,
        asOf: snapshot?.fetchedAt ?? null,
        spend: windowSpendOf(turns.filter((r) => turnAccount(r) === a.id), windows),
      }
    })
})
/** True when any row has a window to show — the legacy "no reading" line
 *  only makes sense when nothing at all is known. */
const anyQuota = computed(() => quotaRows.value.some((r) => r.windows.length > 0))

// The turn the quota limit landed in: the detection stamp falls in
// [started_at, next started_at). Detection is a 5s poll, so the stamp can
// post-date a retry that already finished — the mark says "around here",
// which the footnote spells out. Only the latest hit exists on the pane.
const limitHitTurn = computed<number | null>(() => {
  const pane = props.pane
  const stamp = pane?.usageLimitSeenAt ?? pane?.usageLimitAt ?? null
  const turns = result.value?.turns
  if (stamp == null || !turns?.length) return null
  for (let i = 0; i < turns.length; i++) {
    const startRaw = turns[i].started_at
    const start = startRaw ? Date.parse(startRaw) : NaN
    if (!Number.isFinite(start) || stamp < start) continue
    const nextRaw = turns[i + 1]?.started_at
    const next = nextRaw ? Date.parse(nextRaw) : Number.POSITIVE_INFINITY
    if (stamp < next) return turns[i].turn_index
  }
  return null
})
const limitHitTitle = computed(() => {
  const until = props.pane?.usageLimitUntil
  return until != null
    ? t('turn-stats.limit-hit-row', { time: clock(new Date(until).toISOString()) })
    : t('turn-stats.limit-hit-row-no-reset')
})

// ── Formatting ──────────────────────────────────────────────────────────────
function num(n: number): string {
  return n.toLocaleString('en-US')
}
// Same tiers as the Token panel: the headline must not stretch past "1.5M".
function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  return (n / 1_000_000_000).toFixed(1) + 'B'
}
function clock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const two = (v: number): string => String(v).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}
function pct(n: number): string {
  return `${Math.round(n)}%`
}
const shortSession = computed(() => {
  const id = result.value?.session_id ?? props.pane?.sessionId ?? ''
  return id.length > 8 ? id.slice(0, 8) + '…' : id
})

// ── CSV export ──────────────────────────────────────────────────────────────
const CSV_HEADER = [
  'turn', 'started_at', 'ended_at', 'account', 'profile_id', 'cli_version', 'prompt',
  'input', 'cache_read', 'cache_creation', 'output', 'total', 'calls'
]
function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
/** Oldest first, the way the transcript reads; exported for the test. The
 *  account column is the display name, profile_id the stable id behind it. */
function buildCsv(turns: TokenTurn[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const r of turns) {
    lines.push(
      [
        r.turn_index, r.started_at, r.ended_at,
        r.profile_id === undefined ? '' : accountLabel(r.profile_id), r.profile_id === undefined ? '' : turnAccount(r), r.cli_version ?? '',
        r.prompt_excerpt, r.input, r.cache_read, r.cache_creation, r.output, r.total, r.calls
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return lines.join('\n') + '\n'
}
function exportCsv(): void {
  const res = result.value
  if (!res || res.turns.length === 0) return
  const blob = new Blob([buildCsv(filteredTurns.value)], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `turn-stats-${res.vendor}-${res.session_id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

defineExpose({ buildCsv })
</script>

<template>
  <div class="ts-view">
    <div class="ts-toolbar">
      <span v-if="pane" class="ts-pane-name" v-truncate data-part="pane-name">{{ pane.agentLabel }}</span>
      <span v-if="shortSession" class="ts-session" v-truncate="result?.session_id" data-part="session">
        {{ t('turn-stats.session') }} {{ shortSession }}
      </span>
      <span class="ts-spacer" />
      <button
        class="ts-ghost"
        data-act="toggle-version"
        :data-on="showVersion ? 'true' : 'false'"
        :title="t('turn-stats.version-toggle')"
        @click="showVersion = !showVersion"
      >
        {{ showVersion ? t('turn-stats.version-hide') : t('turn-stats.version-show') }}
      </button>
      <button class="ts-ghost" data-act="export" :disabled="panel !== 'table'" @click="exportCsv">
        {{ t('turn-stats.export') }}
      </button>
      <button class="ts-ghost" data-act="rescan" :disabled="!pane || turnsApi.loading.value" @click="rescan">
        {{ t('turn-stats.rescan') }}
      </button>
    </div>

    <div v-if="result && panel === 'table'" class="ts-summary">
      <span class="ts-summary-main" data-part="summary">
        {{ t('turn-stats.summary', {
          turns: result.turns.length,
          calls: num(result.totals.calls),
          total: compact(result.totals.total),
        }) }}
      </span>
      <span class="ts-method" :data-method="method">
        {{ method === 'exact' ? t('turn-stats.method-exact') : t('turn-stats.method-inferred') }}
      </span>
      <span v-if="method === 'inferred'" class="ts-method-note" data-part="method-note">
        {{ t('turn-stats.method-inferred-note') }}
      </span>
    </div>

    <!-- Account filter: one chip per account the session touched. -->
    <div v-if="panel === 'table' && hasAccounts" class="ts-filter" data-part="account-filter">
      <span class="ts-filter-title">{{ t('turn-stats.account-filter') }}</span>
      <button
        class="ts-chip"
        data-act="account-chip"
        data-account=""
        :class="{ on: accountFilter === '' }"
        @click="accountFilter = ''"
      >{{ t('turn-stats.account-all') }}</button>
      <button
        v-for="a in accounts"
        :key="a.id"
        class="ts-chip"
        data-act="account-chip"
        :data-account="a.id"
        :class="{ on: accountFilter === a.id, unknown: a.id === UNKNOWN_PROFILE_ID }"
        :title="a.id"
        @click="accountFilter = accountFilter === a.id ? '' : a.id"
      >{{ accountLabel(a.id) }} ({{ t('turn-stats.account-turns', { turns: a.turns }) }})</button>
      <button
        v-if="versionFilter"
        class="ts-chip on"
        data-act="version-chip"
        :title="t('turn-stats.version-filter-clear')"
        @click="versionFilter = ''"
      >{{ t('turn-stats.col-version') }} {{ versionFilter }} ✕</button>
    </div>

    <!-- Quota: each account's windows as the badge reads them, and — for
         Claude, whose session window is a fixed 5h — what this session cost
         inside that account's window. -->
    <div v-if="pane && panel !== 'no-panes'" class="ts-quota" data-part="quota">
      <span class="ts-quota-title">{{ t('turn-stats.quota-title') }}</span>
      <span v-if="!hasAccounts && !anyQuota" class="ts-quota-none" data-part="quota-none">{{ t('turn-stats.quota-none') }}</span>
      <div
        v-for="row in quotaRows"
        :key="row.id"
        class="ts-quota-row"
        data-part="quota-account"
        :data-account="row.id"
        :data-active="row.active === null ? undefined : row.active ? 'true' : 'false'"
        :data-stale="row.stale ? 'true' : 'false'"
      >
        <span v-if="row.active !== null" class="ts-quota-account" data-part="quota-account-name" :title="row.id">
          <span class="ts-quota-account-label">{{ row.label }}</span>
          <span v-if="!row.unknown" class="ts-quota-active" :class="{ on: row.active }" data-part="quota-active">
            {{ row.active ? t('account-dim.active') : t('account-dim.inactive') }}
          </span>
          <span v-if="row.asOf" class="ts-quota-asof" data-part="quota-asof">
            {{ row.stale ? t('turn-stats.quota-as-of-stale', { time: clock(row.asOf) }) : t('turn-stats.quota-as-of', { time: clock(row.asOf) }) }}
          </span>
        </span>
        <span v-if="row.unknown" class="ts-quota-unknown" data-part="quota-unknown">{{ t('turn-stats.quota-unknown-account') }}</span>
        <template v-else-if="row.windows.length">
          <span
            v-for="w in row.windows"
            :key="`${w.kind}:${w.label}`"
            class="ts-quota-window"
            data-part="quota-window"
            :data-kind="w.kind"
            :data-exhausted="w.exhausted ? 'true' : 'false'"
          >
            {{ w.label }} {{ pct(w.usedPercent) }}<template v-if="w.resetsAt"> · {{ t('turn-stats.quota-resets', { time: formatResetAbsolute(w.resetsAt) }) }}</template>
          </span>
        </template>
        <span v-else-if="row.removed" class="ts-quota-none" data-part="quota-removed">{{ t('turn-stats.quota-removed') }}</span>
        <span v-else-if="row.active !== null" class="ts-quota-none" data-part="quota-account-none">{{ t('turn-stats.quota-none') }}</span>
        <span v-if="panel === 'table' && (row.windows.length || row.active === null) && !row.unknown" class="ts-quota-spend" data-part="quota-spend">
          <template v-if="row.spend">
            {{ t('turn-stats.quota-window-spend', { from: clock(row.spend.start), to: clock(row.spend.end) }) }}
            <strong>{{ num(row.spend.total) }}</strong>
            ({{ t('turn-stats.col-input') }} {{ num(row.spend.input) }} · {{ t('turn-stats.col-cache-read') }} {{ num(row.spend.cache_read) }} · {{ t('turn-stats.col-cache-write') }} {{ num(row.spend.cache_creation) }} · {{ t('turn-stats.col-output') }} {{ num(row.spend.output) }} · {{ t('turn-stats.col-calls') }} {{ num(row.spend.calls) }} · {{ row.spend.turns }} {{ t('turn-stats.quota-window-turns') }})
            <template v-if="row.spend.turns === 0 && row.spend.lastTurnAt"> · {{ t('turn-stats.quota-last-turn', { time: clock(row.spend.lastTurnAt) }) }}</template>
          </template>
          <template v-else>{{ t('turn-stats.quota-window-spend-unknown') }}</template>
        </span>
      </div>
    </div>

    <!-- Version chart: average spend per turn by CLI version, folded by default. -->
    <div v-if="panel === 'table' && versionRows.length" class="ts-chart" data-part="version-chart">
      <button class="ts-chart-toggle" data-act="toggle-version-chart" :aria-expanded="showVersionChart ? 'true' : 'false'" @click="showVersionChart = !showVersionChart">
        <span class="ts-chart-caret">{{ showVersionChart ? '▾' : '▸' }}</span>
        {{ t('turn-stats.version-chart-title') }}
        <span class="ts-chart-hint">{{ t('turn-stats.version-chart-hint') }}</span>
      </button>
      <HBars
        v-if="showVersionChart"
        :rows="versionBars"
        :value-format="compact"
        :selected="selectedVersionIndex"
        :ariaLabel="t('turn-stats.version-chart-title')"
        :empty-text="t('turn-stats.empty-turns')"
        @select="onVersionSelect"
      />
    </div>

    <div class="ts-body">
      <p v-if="panel === 'no-panes'" class="ts-empty" data-state="no-panes">{{ t('turn-stats.empty-panes') }}</p>
      <p v-else-if="panel === 'never-started'" class="ts-empty" data-state="never-started">
        {{ t('turn-stats.error-never-started') }}
      </p>
      <p v-else-if="panel === 'unsupported'" class="ts-empty" data-state="unsupported">
        {{ t('turn-stats.method-unsupported') }}
      </p>
      <p v-else-if="panel === 'loading'" class="ts-empty" data-state="loading">{{ t('turn-stats.scanning') }}</p>
      <p v-else-if="panel === 'error'" class="ts-empty ts-error" data-state="error">{{ errorText }}</p>
      <p v-else-if="panel === 'empty'" class="ts-empty" data-state="empty">{{ t('turn-stats.empty-turns') }}</p>
      <table v-else class="ts-table" data-state="table">
        <thead>
          <tr>
            <th class="c-idx">#</th>
            <th class="c-time">{{ t('turn-stats.col-time') }}</th>
            <th v-if="hasAccounts" class="c-account" v-truncate>{{ t('turn-stats.col-account') }}</th>
            <th v-if="showVersion" class="c-version">{{ t('turn-stats.col-version') }}</th>
            <th class="c-prompt" v-truncate>{{ t('turn-stats.col-prompt') }}</th>
            <th class="c-num">{{ t('turn-stats.col-input') }}</th>
            <th class="c-num">{{ t('turn-stats.col-cache-read') }}</th>
            <th class="c-num">{{ t('turn-stats.col-cache-write') }}</th>
            <th class="c-num">{{ t('turn-stats.col-output') }}</th>
            <th class="c-num c-total">{{ t('turn-stats.col-total') }}</th>
            <th class="c-num">{{ t('turn-stats.col-calls') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0" data-state="filtered-empty">
            <td :colspan="columnCount" class="ts-empty">{{ t('turn-stats.empty-filtered') }}</td>
          </tr>
          <template v-for="r in rows" :key="r.turn_index">
            <tr
              class="ts-row"
              data-row="turn"
              :data-turn="r.turn_index"
              :data-account="r.profile_id === undefined ? undefined : turnAccount(r)"
              :data-expanded="expanded.has(r.turn_index) ? 'true' : 'false'"
              :data-limit-hit="limitHitTurn === r.turn_index ? 'true' : 'false'"
              @click="toggle(r.turn_index)"
            >
              <td class="c-idx">
                <span v-if="limitHitTurn === r.turn_index" class="ts-limit-mark" data-part="limit-mark" :title="limitHitTitle">⛔</span>{{ r.turn_index }}
              </td>
              <td class="c-time">{{ clock(r.started_at) }}</td>
              <td v-if="hasAccounts" class="c-account" v-truncate data-part="account" :class="{ unknown: turnAccount(r) === UNKNOWN_PROFILE_ID }" :title="turnAccount(r)">
                {{ accountLabel(r.profile_id) }}
              </td>
              <td v-if="showVersion" class="c-version" data-part="version">{{ r.cli_version || '—' }}</td>
              <td class="c-prompt" v-truncate>
                <span :class="{ 'ts-no-prompt': !r.prompt_excerpt }">
                  {{ r.prompt_excerpt || t('turn-stats.no-prompt') }}
                </span>
              </td>
              <td class="c-num" data-part="input">{{ num(r.input) }}</td>
              <td class="c-num" data-part="cache-read">{{ num(r.cache_read) }}</td>
              <td class="c-num" data-part="cache-write">{{ num(r.cache_creation) }}</td>
              <td class="c-num" data-part="output">{{ num(r.output) }}</td>
              <td class="c-num c-total" data-part="total">{{ num(r.total) }}</td>
              <td class="c-num" data-part="calls">{{ num(r.calls) }}</td>
            </tr>
            <tr v-if="expanded.has(r.turn_index)" class="ts-detail" data-row="detail" :data-turn="r.turn_index">
              <td :colspan="columnCount">
                <p v-if="!r.calls_detail?.length" class="ts-detail-empty">{{ t('turn-stats.no-calls') }}</p>
                <table v-else class="ts-calls">
                  <tbody>
                    <tr v-for="(c, i) in r.calls_detail" :key="i" data-row="call">
                      <td class="c-time">{{ clock(c.ts) }}</td>
                      <td class="c-model">{{ c.model }}</td>
                      <td v-if="showVersion" class="c-version" data-part="call-version">{{ c.cli_version || '' }}</td>
                      <td class="c-num">{{ num(c.input) }}</td>
                      <td class="c-num">{{ num(c.cache_read) }}</td>
                      <td class="c-num">{{ num(c.cache_creation) }}</td>
                      <td class="c-num">{{ num(c.output) }}</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
        <tfoot v-if="result">
          <tr
            v-for="sub in subtotals"
            :key="sub.id"
            class="ts-subtotal"
            data-row="subtotal"
            :data-account="sub.id"
          >
            <td class="c-idx" />
            <td class="c-time" />
            <td class="c-account" :title="sub.id" />
            <td v-if="showVersion" class="c-version" />
            <td class="c-prompt" v-truncate>{{ t('turn-stats.row-subtotal', { account: sub.label, turns: sub.sum.turns }) }}</td>
            <td class="c-num" data-part="input">{{ num(sub.sum.input) }}</td>
            <td class="c-num" data-part="cache-read">{{ num(sub.sum.cache_read) }}</td>
            <td class="c-num" data-part="cache-write">{{ num(sub.sum.cache_creation) }}</td>
            <td class="c-num" data-part="output">{{ num(sub.sum.output) }}</td>
            <td class="c-num c-total" data-part="total">{{ num(sub.sum.total) }}</td>
            <td class="c-num" data-part="calls">{{ num(sub.sum.calls) }}</td>
          </tr>
          <tr class="ts-total" data-row="totals">
            <td class="c-idx" />
            <td class="c-time" />
            <td v-if="hasAccounts" class="c-account" />
            <td v-if="showVersion" class="c-version" />
            <td class="c-prompt" v-truncate>{{ t('turn-stats.row-total') }} ({{ t('turn-stats.account-turns', { turns: visibleTotals.turns }) }})</td>
            <td class="c-num" data-part="input">{{ num(visibleTotals.input) }}</td>
            <td class="c-num" data-part="cache-read">{{ num(visibleTotals.cache_read) }}</td>
            <td class="c-num" data-part="cache-write">{{ num(visibleTotals.cache_creation) }}</td>
            <td class="c-num" data-part="output">{{ num(visibleTotals.output) }}</td>
            <td class="c-num c-total" data-part="total">{{ num(visibleTotals.total) }}</td>
            <td class="c-num" data-part="calls">{{ num(visibleTotals.calls) }}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="ts-foot">
      <span class="ts-foot-note" data-part="note">{{ t('turn-stats.note') }}</span>
      <span v-if="limitHitTurn !== null" class="ts-limit-note" data-part="limit-note">{{ t('turn-stats.limit-hit-note') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* One gutter for every band, matching the page title above the view. */
.ts-view {
  --ts-gutter: 24px;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  overflow: hidden;
}
.ts-spacer { flex: 1; }

/* ── Header: pane name, session, actions ─────────────────────────────────── */
.ts-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px var(--ts-gutter) 10px;
}
.ts-pane-name {
  color: var(--text-bright);
  font-weight: 600;
  font-size: var(--font-md);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-session {
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: var(--font-3xs);
  font-variant-numeric: tabular-nums;
}
.ts-ghost {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}
.ts-ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  color: var(--text-bright);
}
.ts-ghost:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.ts-ghost:disabled { color: var(--text-disabled); cursor: default; }

/* ── Headline ────────────────────────────────────────────────────────────── */
.ts-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px var(--ts-gutter) 14px;
}
.ts-summary-main {
  color: var(--text-bright);
  font-weight: 700;
  font-size: var(--font-xl);
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.ts-method {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-3xs);
  font-weight: 600;
}
.ts-method[data-method='inferred'] {
  background: transparent;
  color: var(--warning-fg);
  border: 1px solid var(--warning-fg);
}
.ts-method-note { color: var(--text-muted); font-size: var(--font-3xs); }

.ts-body {
  flex: 1 1 auto;
  min-height: 120px;
  overflow: auto;
  border-top: 1px solid var(--border-muted);
}
.ts-empty {
  margin: 0;
  padding: 32px var(--ts-gutter);
  color: var(--text-muted);
  text-align: center;
}
.ts-error { color: var(--attention-fg); }

/* ── The turns table ─────────────────────────────────────────────────────── */
.ts-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-variant-numeric: tabular-nums;
}
.ts-table th,
.ts-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
  white-space: nowrap;
}
.ts-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--bg-base);
  border-bottom-color: var(--border-default);
  color: var(--text-muted);
  font-weight: 500;
  font-size: var(--font-3xs);
  letter-spacing: 0.02em;
  text-align: left;
}
.ts-table th:first-child,
.ts-table td:first-child { padding-left: var(--ts-gutter); }
.ts-table th:last-child,
.ts-table td:last-child { padding-right: var(--ts-gutter); }
.c-idx { width: 3ch; color: var(--text-muted); text-align: right; }
.c-time { width: 9ch; color: var(--text-muted); }
.c-prompt {
  max-width: 0;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-primary);
}
.ts-no-prompt { color: var(--text-muted); font-style: italic; }
.ts-table th.c-num,
.ts-table td.c-num { text-align: right; }
.ts-table td.c-num { color: var(--text-secondary); }
.ts-table td.c-total { color: var(--text-bright); font-weight: 600; }
.ts-table th.c-total { color: var(--text-secondary); font-weight: 600; }
.ts-row { cursor: pointer; transition: background-color 100ms ease; }
.ts-row:hover { background: var(--bg-hover-faint); }
.ts-row[data-expanded='true'] { background: var(--bg-hover-faint); }
.ts-row[data-expanded='true'] td { border-bottom-color: transparent; }

.ts-detail td {
  padding: 4px var(--ts-gutter) 10px 56px;
  background: var(--bg-hover-faint);
}
.ts-detail-empty { margin: 0; color: var(--text-muted); font-size: var(--font-3xs); }
.ts-calls { border-collapse: collapse; font-size: var(--font-3xs); }
.ts-calls td { padding: 2px 14px 2px 0; border: 0; color: var(--text-muted); }
.ts-calls .c-model { color: var(--text-secondary); }

/* The grand total stays in view while the turns scroll under it. */
.ts-total td {
  position: sticky;
  bottom: 0;
  border-top: 1px solid var(--border-default);
  border-bottom: 0;
  color: var(--text-bright);
  font-weight: 700;
  background: var(--bg-subtle);
}
.ts-table .ts-total td.c-num { color: var(--text-bright); }

/* ── Quota (from the usage badge's snapshot) ─────────────────────────────── */
.ts-quota {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: baseline;
  gap: 6px 16px;
  margin: 0 var(--ts-gutter) 12px;
  padding: 10px 14px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  font-size: var(--font-2xs);
  color: var(--text-muted);
}
.ts-quota-title { grid-column: 1; color: var(--text-secondary); font-weight: 600; }
.ts-quota-window { font-variant-numeric: tabular-nums; }
.ts-quota-window[data-exhausted='true'] { color: var(--danger-fg); font-weight: 600; }
.ts-quota-spend { flex-basis: 100%; font-variant-numeric: tabular-nums; }
.ts-quota-spend strong { color: var(--text-bright); font-weight: 600; }
.ts-quota-none { grid-column: 2; color: var(--text-muted); }

/* The turn that ran into the quota limit. */
.ts-row[data-limit-hit='true'] .c-idx { color: var(--danger-fg); }
.ts-limit-mark { margin-right: 3px; color: var(--danger-fg); }
.ts-limit-note { color: var(--text-muted); font-size: var(--font-3xs); }

.ts-foot {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px var(--ts-gutter);
  border-top: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.ts-foot-note { line-height: 1.5; }
/* ── Account filter chips ────────────────────────────────────────────────── */
.ts-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 0 var(--ts-gutter) 12px;
  font-size: var(--font-2xs);
}
.ts-filter-title { color: var(--text-muted); margin-right: 4px; }
.ts-chip {
  height: 24px;
  padding: 0 11px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}
.ts-chip:hover { color: var(--text-bright); border-color: var(--border-default); background: var(--bg-hover-faint); }
.ts-chip.on {
  background: var(--accent-subtle);
  border-color: var(--accent-muted);
  color: var(--accent-fg);
  font-weight: 600;
}
.ts-chip.unknown:not(.on) { color: var(--text-muted); }

/* ── Account and version columns ─────────────────────────────────────────── */
.c-account {
  max-width: 18ch;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}
.c-account.unknown { color: var(--text-disabled); }
.c-version { width: 8ch; color: var(--text-muted); font-family: var(--font-mono); font-size: var(--font-3xs); }
.ts-subtotal td {
  border-top: 1px solid var(--border-default);
  border-bottom: 0;
  color: var(--text-secondary);
  background: var(--bg-subtle);
}
.ts-subtotal .c-total { color: var(--text-primary); }
.ts-table tfoot tr + tr td { border-top: 0; }

/* ── Per-account quota rows ──────────────────────────────────────────────── */
.ts-quota-row {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 14px;
}
.ts-quota-row[data-stale='true'] .ts-quota-window {
  color: var(--text-muted);
  text-decoration: underline dashed;
  text-underline-offset: 3px;
}
.ts-quota-account { display: inline-flex; align-items: baseline; gap: 6px; }
.ts-quota-account-label { color: var(--text-primary); font-weight: 600; }
.ts-quota-active {
  padding: 0 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-muted);
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.ts-quota-active.on {
  color: var(--success-fg);
  border-color: var(--success-muted);
  background: var(--success-subtle);
}
.ts-quota-asof { font-size: var(--font-3xs); color: var(--text-muted); }
.ts-quota-unknown { color: var(--text-muted); }

/* ── Version chart (folded by default) ───────────────────────────────────── */
.ts-chart {
  padding: 8px var(--ts-gutter);
  border-top: 1px solid var(--border-muted);
}
.ts-chart-toggle {
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
.ts-chart-toggle:hover { color: var(--text-bright); }
.ts-chart-caret { color: var(--text-muted); }
.ts-chart-hint { color: var(--text-muted); font-weight: 400; font-size: var(--font-3xs); }
</style>
