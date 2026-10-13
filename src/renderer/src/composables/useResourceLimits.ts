// Settings → General → Resource limits.
//
// Every limit here defaults to what Navide did before the limit existed, so
// nothing changes until the user turns one on, and every reader fails open: a
// missing or malformed value means "no limit". The keys are shared with the
// backend (backend/agent_team_backend/resource_limits.py), which applies them.
//
// Module-scoped refs, like usePushChannelPrefs: another window editing the
// same value has to repaint this one.

import { ref, type Ref } from 'vue'

import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

/** Test-runner worker cap; 0 is off. See resource_limits.TEST_WORKERS_KEY. */
export const TEST_MAX_WORKERS_KEY = 'agentTeam.limits.testMaxWorkers'
export const TEST_MAX_WORKERS_MIN = 1
export const TEST_MAX_WORKERS_MAX = 64
/** What switching the cap on starts from. */
export const TEST_MAX_WORKERS_ON_DEFAULT = 4

/** Minutes after an evolve run times out before its pane is reclaimed; 0 is
 *  never. See resource_limits.EVOLVE_RECLAIM_KEY — the defaults must match. */
export const EVOLVE_RECLAIM_KEY = 'agentTeam.limits.evolveTimeoutReclaimMinutes'
export const EVOLVE_RECLAIM_DEFAULT_MINUTES = 30
export const EVOLVE_RECLAIM_MIN_MINUTES = 1
export const EVOLVE_RECLAIM_MAX_MINUTES = 24 * 60

/** Hours a focused pane may sit untouched before the idle sweep may reclaim it
 *  too; 0 (the default) keeps today's rule that the focused pane is never
 *  reclaimed. Renderer-only: the sweep runs in App.vue (lib/idleReclaim.ts). */
export const FOCUSED_RECLAIM_KEY = 'agentTeam.limits.focusedReclaimHours'
export const FOCUSED_RECLAIM_MIN_HOURS = 1
export const FOCUSED_RECLAIM_MAX_HOURS = 48
export const FOCUSED_RECLAIM_ON_DEFAULT = 4

/** Mark new panes so servers they leave behind can be listed; on unless
 *  explicitly off. See resource_limits.TRACK_DETACHED_KEY. */
export const TRACK_DETACHED_KEY = 'agentTeam.limits.trackDetachedServers'

/** An integer in [low, high] read from settings; anything else is `fallback`. */
function readInt(key: string, fallback: number, low: number, high: number): number {
  const raw = settingsGet<unknown>(key, fallback)
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  return typeof n === 'number' && Number.isInteger(n) && n >= low && n <= high ? n : fallback
}

interface IntLimit {
  key: string
  fallback: number
  low: number
  high: number
  value: Ref<number>
}

const limits: IntLimit[] = []

function intLimit(key: string, fallback: number, low: number, high: number): IntLimit {
  const limit: IntLimit = { key, fallback, low, high, value: ref(readInt(key, fallback, low, high)) }
  limits.push(limit)
  return limit
}

// 0 = off is inside the accepted range so "off" round-trips as a stored value.
const testMaxWorkers = intLimit(TEST_MAX_WORKERS_KEY, 0, 0, TEST_MAX_WORKERS_MAX)
const focusedReclaimHours = intLimit(FOCUSED_RECLAIM_KEY, 0, 0, FOCUSED_RECLAIM_MAX_HOURS)
const evolveReclaimMinutes = intLimit(EVOLVE_RECLAIM_KEY, EVOLVE_RECLAIM_DEFAULT_MINUTES, 0, EVOLVE_RECLAIM_MAX_MINUTES)

function readTrackDetached(): boolean {
  const raw = settingsGet<unknown>(TRACK_DETACHED_KEY, true)
  return !(raw === false || raw === 0 || raw === '0' || raw === 'false')
}

const trackDetached = ref(readTrackDetached())

onSettingsChanged((keys) => {
  if (keys.includes(TRACK_DETACHED_KEY)) trackDetached.value = readTrackDetached()
  for (const limit of limits) {
    if (keys.includes(limit.key)) limit.value.value = readInt(limit.key, limit.fallback, limit.low, limit.high)
  }
})

/** Store a value if it is in range; returns whether it was accepted. */
function setIntLimit(limit: IntLimit, next: number): boolean {
  if (!Number.isInteger(next) || next < limit.low || next > limit.high) return false
  limit.value.value = next
  settingsSet(limit.key, next)
  return true
}

export function setTestMaxWorkers(next: number): boolean {
  return setIntLimit(testMaxWorkers, next)
}

export function setEvolveReclaimMinutes(next: number): boolean {
  return setIntLimit(evolveReclaimMinutes, next)
}

export function setFocusedReclaimHours(next: number): boolean {
  return setIntLimit(focusedReclaimHours, next)
}

export function setTrackDetached(on: boolean): void {
  trackDetached.value = on
  settingsSet(TRACK_DETACHED_KEY, on)
}

export function useResourceLimits() {
  return {
    testMaxWorkers: testMaxWorkers.value,
    evolveReclaimMinutes: evolveReclaimMinutes.value,
    focusedReclaimHours: focusedReclaimHours.value,
    trackDetached,
  }
}

/** Test hook: re-read every limit from the (reset) settings cache. */
export function _resetResourceLimitsForTest(): void {
  trackDetached.value = readTrackDetached()
  for (const limit of limits) limit.value.value = readInt(limit.key, limit.fallback, limit.low, limit.high)
}
