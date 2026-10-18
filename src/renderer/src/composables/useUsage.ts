import { reactive, ref, watch } from 'vue'
import type { useBackend } from './useBackend'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'

// Module-singleton store for per-CLI quota snapshots (CodexBar-style badges).
// The backend owns the poller (`usage_service.py`) and broadcasts
// `usage.changed`; this module mirrors the latest payload so any component
// (TerminalPane's UsageBadge) can read it without prop threading — same
// facade pattern as lib/settings.ts.

export const USAGE_ENABLED_KEY = 'agentTeam.usageBadge.enabled'
export const USAGE_REFRESH_KEY = 'agentTeam.usageBadge.refreshSec'
export const USAGE_REFRESH_OPTIONS = [60, 300, 900, 1800] as const
export const USAGE_DEFAULT_REFRESH_SEC = 300

export type UsageStatus =
  | 'ok'
  | 'no-credentials'
  | 'expired'
  | 'rate-limited'
  | 'unavailable'
  // Claude only: its quota comes from driving the CLI, so a missing binary is
  // not the same as "this provider has no usage surface" — it is the one
  // failure the user can act on.
  | 'cli-missing'
  // Parked Claude accounts: the CLI's `/usage` panel only speaks for whoever is
  // signed in, so a non-active account carries no figure at all.
  | 'not-measured'
  // A managed credential store nobody has verified yet: only opening a
  // standard pane does that, so there is nothing to read until then.
  | 'unverified'
  | 'error'

/** Statuses with a `usage.refresh-status-*` translation. Shared so the badge
 *  and the accounts pane can't drift apart and print a raw key. */
export const TRANSLATED_REFRESH_STATUSES: ReadonlySet<string> = new Set<UsageStatus | 'not-refreshed'>([
  'ok',
  'not-refreshed',
  'no-credentials',
  'expired',
  'rate-limited',
  'unavailable',
  'cli-missing',
  'not-measured',
  'unverified',
  'error'
])

export interface UsageWindow {
  kind: 'session' | 'weekly' | 'weekly-model' | 'monthly' | string
  label: string
  usedPercent: number
  resetsAt: string | null
  expired?: boolean
}

export interface UsageSnapshot {
  provider: string
  status: UsageStatus
  planType: string | null
  windows: UsageWindow[]
  fetchedAt: string
  error: string | null
  stale?: boolean
  lastSuccessAt?: string | null
  refreshStatus?: UsageStatus | 'not-refreshed'
  refreshAttemptedAt?: string | null
  staleExpired?: boolean
  /** Claude only: this account just became active and its figure is being read
   *  right now. Reading it boots a whole Claude Code, so the numbers on screen
   *  belong to an earlier reading until the poll lands — say so rather than
   *  let them pass for the switch's result. Cleared by the snapshot the poll
   *  writes, whatever that snapshot turns out to be. */
  refreshPending?: boolean
}

interface UsagePayload {
  providers?: Record<string, UsageSnapshot>
  accounts?: Record<string, Record<string, UsageSnapshot>>
  enabled?: boolean
  intervalSec?: number
}

type Backend = ReturnType<typeof useBackend>

const state = reactive<{
  providers: Record<string, UsageSnapshot>
  accounts: Record<string, Record<string, UsageSnapshot>>
}>({ providers: {}, accounts: {} })

/** Bumped on every payload the backend hands us. A manual refresh has no
 *  response of its own (the poller answers by broadcasting `usage.changed`
 *  when the cycle finishes), so this is how a caller knows its request
 *  landed — reading a Claude account means booting a whole CLI, so that can
 *  be tens of seconds after the click. */
export const usageVersion = ref(0)

let backend: Backend | null = null
let offChanged: (() => void) | null = null
let stopStatusWatch: (() => void) | null = null

function applyPayload(payload: UsagePayload | null | undefined): void {
  if (!payload || typeof payload !== 'object') return
  usageVersion.value++
  if (payload.providers && typeof payload.providers === 'object') {
    state.providers = { ...payload.providers }
  }
  if (payload.accounts && typeof payload.accounts === 'object') {
    state.accounts = { ...payload.accounts }
  } else if (payload.providers && typeof payload.providers === 'object') {
    // A providers-only payload comes from a legacy backend. Do not retain
    // per-account snapshots from a previously connected newer backend.
    state.accounts = {}
  }
}

export function usageEnabled(): boolean {
  return settingsGet<boolean>(USAGE_ENABLED_KEY, true) !== false
}

export function usageRefreshSec(): number {
  const raw = Number(settingsGet<number>(USAGE_REFRESH_KEY, USAGE_DEFAULT_REFRESH_SEC))
  return Number.isFinite(raw) && raw >= 60 ? raw : USAGE_DEFAULT_REFRESH_SEC
}

async function sendConfigure(): Promise<void> {
  const b = backend
  if (!b || b.status.value !== 'connected') return
  try {
    const resp = await b.send<UsagePayload>('usage.configure', {
      enabled: usageEnabled(),
      intervalSec: usageRefreshSec()
    })
    if (resp.ok) applyPayload(resp.payload)
  } catch (err) {
    console.warn('[usage] configure failed', err)
  }
}

/** Wire the store to the window's backend (call once from App.vue, next to
 *  initSettingsBackend). Re-sends the poller config on every (re)connect. */
export function initUsage(b: Backend): void {
  if (backend) return
  backend = b
  offChanged = b.on('usage.changed', (raw) => applyPayload(raw as UsagePayload))
  stopStatusWatch = watch(
    () => b.status.value,
    (s) => {
      if (s === 'connected') void sendConfigure()
    },
    { immediate: true }
  )
}

/** Push the current settings values to the backend poller (call after a
 *  settings change; also hides/starts polling via `enabled`). */
export function reconfigureUsage(): void {
  void sendConfigure()
}

export function setUsageEnabled(enabled: boolean): void {
  settingsSet(USAGE_ENABLED_KEY, enabled)
  reconfigureUsage()
}

export function setUsageRefreshSec(sec: number): void {
  settingsSet(USAGE_REFRESH_KEY, sec)
  reconfigureUsage()
}

/** Force an immediate re-poll (clears provider cooldowns backend-side).
 *  With `agentKey` only that provider's cooldown is cleared, so one account
 *  card can be refreshed without also paying for the others (reading Claude
 *  boots a whole Claude Code). `slotId` addresses a Claude account slot,
 *  whose cooldowns are kept per account.
 *  Returns false when there is no connected backend to ask — a caller showing
 *  a "refreshing…" state has nothing to wait for in that case. */
export function refreshUsage(agentKey?: string, slotId?: string | null): boolean {
  const b = backend
  if (!b || b.status.value !== 'connected') return false
  const scope = agentKey ? { agentKey, slotId: slotId ?? '__default__' } : {}
  void b.send('usage.refresh', scope).catch(() => {})
  return true
}

/** True while the window's backend is connected. The store keeps the last
 *  payload across a disconnect, so a "reading now" flag in it would otherwise
 *  promise a read whose answer can no longer arrive. Display only: the
 *  snapshots themselves are left untouched. */
export function usageBackendConnected(): boolean {
  return backend?.status.value === 'connected'
}

/** Snapshot for a pane's agent key, or undefined when the agent has no
 *  usage provider (aider/terminal) or nothing was fetched yet. The backend
 *  is the single source of who has a provider: agents without one are simply
 *  never present in the payload, so no frontend allowlist is needed. */
export function usageFor(agentKey: string | undefined | null): UsageSnapshot | undefined {
  if (!agentKey || !usageEnabled()) return undefined
  return state.providers[agentKey]
}

/** Snapshot for one stable account slot. `null` addresses the built-in Default
 *  row, whose backend slot id is `__default__`. */
export function accountUsageFor(
  agentKey: string | undefined | null,
  profileId: string | null,
): UsageSnapshot | undefined {
  if (!agentKey || !usageEnabled()) return undefined
  const slotId = profileId ?? '__default__'
  return state.accounts[agentKey]?.[slotId]
}

/** Kinds that represent a GENERAL account limit (not a per-model bucket). */
const HEADLINE_KINDS = new Set(['session', 'weekly', 'monthly'])

/** Remaining percentage of the snapshot's headline window. Per-model windows
 *  (kind 'weekly-model', e.g. an exhausted promotional "Fable only" bucket that
 *  Anthropic reports at 100% used but does not actually enforce) must never
 *  drive the badge — otherwise a spent promo makes an otherwise-healthy pane
 *  read as blocked. Prefer the first general window; fall back to the first
 *  window only when no general one exists. */
export function remainingPercent(snap: UsageSnapshot | undefined): number | null {
  if (!snap || snap.status !== 'ok' || snap.windows.length === 0) return null
  const current = snap.windows.filter((w) => !w.expired)
  if (current.length === 0) return null
  const headline = current.find((w) => HEADLINE_KINDS.has(w.kind)) ?? current[0]
  return Math.max(0, Math.min(100, 100 - headline.usedPercent))
}

/** A general window counts as spent at this figure. The panel reports whole
 *  or one-decimal percentages and the backend clamps to 100, so equality IS
 *  the exhausted case — there is no "over 100%". */
const EXHAUSTED_USED_PCT = 100

/** The general-account window that is fully spent, or undefined. Per-model
 *  buckets are excluded for the same reason `remainingPercent` skips them: a
 *  spent promotional bucket reports 100% used without actually blocking work,
 *  so treating it as exhaustion would brand a healthy account as blocked.
 *  A cached snapshot whose reset has already passed carries `expired` on the
 *  window and is skipped too — a spent window from hours ago says nothing
 *  about now. */
export function exhaustedWindow(snap: UsageSnapshot | undefined): UsageWindow | undefined {
  if (!snap || snap.status !== 'ok') return undefined
  return snap.windows.find(
    (w) => !w.expired && HEADLINE_KINDS.has(w.kind) && w.usedPercent >= EXHAUSTED_USED_PCT
  )
}

/** True when this account has no general quota left at all. Deliberately NOT
 *  the same as "remaining rounds to 0%": under 1% still runs, 100% used does
 *  not, and before this the badge printed the same red 0% for both. */
export function isExhausted(snap: UsageSnapshot | undefined): boolean {
  return exhaustedWindow(snap) !== undefined
}

/** True when the account's own reading POSITIVELY says general quota remains:
 *  a successful, current read that measured at least one headline window and
 *  found none of them spent.
 *
 *  The inverse of `isExhausted` would not do. That one answers false for an
 *  account nobody has read, and callers that treat "not exhausted" as "has
 *  quota" turn every unread account into a healthy one. This is the third
 *  state — a reading that is absent, errored, stale or still in flight is
 *  "don't know" and answers false, so a veto built on it can only ever fire
 *  on evidence. */
export function hasHeadlineHeadroom(snap: UsageSnapshot | undefined): boolean {
  if (!readingIsCurrent(snap)) return false
  const headline = snap!.windows.filter((w) => !w.expired && HEADLINE_KINDS.has(w.kind))
  return headline.length > 0 && headline.every((w) => w.usedPercent < EXHAUSTED_USED_PCT)
}

/** True when this snapshot is a reading, rather than something standing in for
 *  one. `status !== 'ok'` is not enough on its own: a refresh that failed, and
 *  the cached figures an account switch publishes before its first read lands,
 *  both keep `status: 'ok'` and carry windows that look exactly like measured
 *  ones. Callers that decide something FROM the reading — either direction —
 *  share this, so "not known yet" cannot pass for an answer at one end while
 *  being rejected at the other. */
export function readingIsCurrent(snap: UsageSnapshot | undefined): boolean {
  if (!snap || snap.status !== 'ok') return false
  return !snap.stale && !snap.staleExpired && !snap.refreshPending
}

/** Severity by REMAINING quota: >40 ok (grey), 15–40 warn (orange), <15 crit (red). */
export function remainingTier(remaining: number): 'ok' | 'warn' | 'crit' {
  if (remaining < 15) return 'crit'
  if (remaining <= 40) return 'warn'
  return 'ok'
}

/** Compact remaining label: whole percent, CodexBar's `<1%` special case. */
export function formatRemaining(remaining: number): string {
  if (remaining > 0 && remaining < 1) return '<1%'
  return `${Math.round(remaining)}%`
}

/** Countdown like "2d 3h" / "3h 15m" / "12m" / '' (past). Minutes round up. */
export function formatResetCountdown(resetsAt: string | null, nowMs?: number): string {
  if (!resetsAt) return ''
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return ''
  const now = nowMs ?? Date.now()
  const totalMin = Math.ceil((target - now) / 60000)
  if (totalMin <= 0) return ''
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  return `${mins}m`
}

/** Absolute local-time form for the popover ("7/28 08:00"). */
export function formatResetAbsolute(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const target = Date.parse(resetsAt)
  if (!Number.isFinite(target)) return ''
  const d = new Date(target)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Test-only: detach and clear the singleton state. */
export function __resetUsageForTest(): void {
  offChanged?.()
  offChanged = null
  stopStatusWatch?.()
  stopStatusWatch = null
  backend = null
  state.providers = {}
  state.accounts = {}
  usageVersion.value = 0
}
