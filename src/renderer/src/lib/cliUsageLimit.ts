// Pane-level detection of a CLI announcing it has run out of quota, and of
// when that quota is expected back.
//
// One answer, two readers: the always-on pane health watcher lights the pane's
// badge from it, and the loop schedules its auto-resume from the same verdict
// instead of matching the text a second time. Before this the loop was the
// ONLY reader, so a pane nobody was looping hit the limit invisibly.

import {
  LIMIT_RESET_BUFFER_MS,
  LOOP_ESTIMATE_WINDOW_MS,
  matchSessionLimit,
  parseLimitEvidence,
  parseLimitReset
} from './loopPrompt'
import { AGENT_SPECS } from '@navide/plugin-shell'
import {
  exhaustedWindow,
  hasHeadlineHeadroom,
  noteSessionLimitNamed,
  usageFor,
  windowAbsent,
  type UsageSnapshot,
  type UsageWindow
} from '../composables/useUsage'

/** The limit announcement stripped of its reset clock, e.g. a wrapped or
 *  reworded "You've hit your usage limit" with no time attached.
 *
 *  Matching this alone is NOT enough: the same phrase occurs in a CLI's own
 *  assistant text (this very feature was written in a pane that printed it),
 *  and lighting a badge off someone's prose is the failure the login-expired
 *  spec avoids by requiring two co-occurring parts. There is no second part
 *  here, so the second signal comes from outside the buffer — the account's
 *  own `/usage` reading must independently say the quota is spent. The clocked
 *  form (matchSessionLimit) is trusted without that, but not against it: see
 *  detectUsageLimit for the veto. */
export const BARE_LIMIT_RE = /hit your .{0,40}limit/i

/** How long a hit whose reset nothing could resolve stands before the flag is
 *  dropped. Claude's rolling session window is the only figure available to
 *  guess with — the alternative is a badge that sticks for the life of the
 *  pane, which is worse than an estimate the UI already labels as one. */
export const USAGE_LIMIT_UNKNOWN_TTL_MS = LOOP_ESTIMATE_WINDOW_MS

/** True when a standing quota flag should be dropped: its resolved reset has
 *  arrived, or — with no resolved reset — the fallback window has elapsed. */
export function usageLimitDue(at: number, until: number | null, now: number): boolean {
  return now >= (until ?? at + USAGE_LIMIT_UNKNOWN_TTL_MS)
}

/** True when a fresh detection is the limit the user already dismissed (or an
 *  account switch already cleared), re-read from a TUI repaint of the old
 *  banner rather than a new hit.
 *
 *  The reset is re-resolved against the poll's own clock, so the same banner
 *  lands up to a second apart between polls. The suppression only holds until
 *  that reset arrives: past it the quota is back, so any later banner — even
 *  one naming the same clock time on another day — is a new hit. An unknown
 *  reset on either side never matches: with no clock there is nothing to tell
 *  an old banner from a new hit by. */
export function isDismissedUsageLimit(
  dismissedUntil: number | null,
  until: number | null,
  now: number
): boolean {
  if (dismissedUntil == null || until == null || now >= dismissedUntil) return false
  return Math.abs(until - dismissedUntil) < 60_000
}

/** A clocked limit sentence the account's reading overruled.
 *
 *  The caller has to tell this apart from "nothing here", because the sentence
 *  is real text sitting in the buffer and a verdict was reached on it. Left
 *  indistinguishable from null it is never consumed, so it is re-judged every
 *  poll until it scrolls out of the scanned tail — and any later change of
 *  state (the reading errors, the account is parked, the window flips) then
 *  promotes prose that is minutes old to a fresh hit, whose bare 12-hour clock
 *  parseLimitReset re-resolves against the CURRENT time and rolls to the next
 *  day. A sentence saying "resets 4:30pm" can that way park a loop until
 *  4:30pm tomorrow.
 *
 *  It also tells the caller the reading disagreed with the buffer, which is
 *  worth a re-read: the sentence was printed seconds ago, the reading it lost
 *  to can be a quarter of an hour old. */
export const QUOTA_READING_VETO = 'quota-reading-veto'

export interface UsageLimitHit {
  /** The matched message, whitespace-collapsed. */
  message: string
  /** Epoch ms to resume at (reset + safety buffer), or null when neither
   *  source could resolve a reset time — callers fail open. */
  resumeAt: number | null
  /** The reset epoch ms the MESSAGE itself stated, without the resume buffer,
   *  or null when it carried no clock. This is the only part of the hit that
   *  says WHICH window was hit — an account has a 5-hour one, a weekly one and
   *  a per-model weekly one open at once, and they run out separately. Unlike
   *  resumeAt it never falls back to the account's reading, because a stamp
   *  derived from the reading cannot then be used to tell which window the
   *  reading was about. */
  resetAt: number | null
  windowKind: string | null
  modelScope: string | null
  resetPrecision: 'exact' | 'minute' | 'hour' | 'clock_only' | 'unknown'
}

export function quotaExhaustedPayload(hit: UsageLimitHit, pane: { agentKey: string; paneId: string }, at: number) {
  return {
    agent_key: pane.agentKey,
    pane_id: pane.paneId,
    at: new Date(at).toISOString(),
    resets_at: hit.resetAt === null ? null : new Date(hit.resetAt).toISOString(),
    window_kind: hit.windowKind,
    model_scope: hit.modelScope,
    reset_precision: hit.resetPrecision
  }
}

/** The weekly window that stands in for the session window, for an account a
 *  reading proved has none. Undefined for every other account. */
function noSessionWeekly(snap: UsageSnapshot | undefined, now: number): UsageWindow | undefined {
  if (!windowAbsent(snap, 'session')) return undefined
  return snap!.windows.find(
    (w) => w.kind === 'weekly' && !w.expired && !!w.resetsAt && Date.parse(w.resetsAt) > now
  )
}

/** The pre-limit reset estimate a running loop shows. `weekly` says which
 *  figure it is: an account with no session window has no 5-hour window to
 *  guess from, so it gets its weekly reset, or no estimate at all. */
export function loopEstimate(
  snap: UsageSnapshot | undefined,
  now: number
): { at: number | null; weekly: boolean } {
  if (!windowAbsent(snap, 'session')) return { at: now + LOOP_ESTIMATE_WINDOW_MS, weekly: false }
  const weekly = noSessionWeekly(snap, now)
  return { at: weekly ? Date.parse(weekly.resetsAt as string) : null, weekly: true }
}

/** Resume time taken from the account's own `/usage` reading: the spent
 *  window's reset, else the session window's, else, for an account with no
 *  session window, the weekly one's.
 *
 *  This is the FALLBACK, not the preferred source. The panel reading can be a
 *  quarter of an hour old (it costs a whole Claude Code start, so it is read
 *  on a long cooldown), while the message in the pane was printed just now and
 *  states the exact reset. Null when the reading is absent or already past — a
 *  reset in the past would resume straight back into an exhausted quota. */
export function usageResumeAt(
  agentKey: string | undefined | null,
  now: number = Date.now()
): number | null {
  const snap = usageFor(agentKey)
  const window =
    exhaustedWindow(snap) ??
    snap?.windows.find((w) => w.kind === 'session' && !w.expired) ??
    noSessionWeekly(snap, now)
  const at = window?.resetsAt ? Date.parse(window.resetsAt) : NaN
  if (!Number.isFinite(at) || at <= now) return null
  return at + LIMIT_RESET_BUFFER_MS
}

/** A hit from its sentence. On an account with no session window, a sentence
 *  with no date cannot be about a 5-hour clock, so the weekly reading says when
 *  the quota is back. A sentence that names the session window keeps its own
 *  clock: it is newer than the reading, and it means the reading was wrong. */
function limitHit(
  agentKey: string | undefined | null,
  message: string,
  resumeAt: number | null,
  now: number
): UsageLimitHit {
  const evidence = parseLimitEvidence(message, now)
  const snap = usageFor(agentKey)
  if (agentKey && evidence.windowKind === 'session' && windowAbsent(snap, 'session')) {
    noteSessionLimitNamed(agentKey, resumeAt ?? now + USAGE_LIMIT_UNKNOWN_TTL_MS)
  }
  const weekly = noSessionWeekly(snap, now)
  const aboutWeekly = (evidence.windowKind ?? 'weekly') === 'weekly' && (evidence.modelScope ?? 'all') === 'all'
  if (!weekly || evidence.resetAt !== null || !aboutWeekly) return { message, resumeAt, ...evidence }
  const resetAt = Date.parse(weekly.resetsAt as string)
  return {
    message,
    resumeAt: resetAt + LIMIT_RESET_BUFFER_MS,
    resetAt,
    windowKind: 'weekly',
    modelScope: 'all',
    resetPrecision: 'minute'
  }
}

/** Detect a quota-limit announcement in a pane's buffer tail.
 *
 *  Returns null when there is none, or when a clockless phrase was not
 *  corroborated by the account's quota reading. `tail` is matched
 *  whitespace-collapsed, tolerating the TUI hard-wrap a narrow pane inserts
 *  mid-phrase (same normalization as matchSessionLimit / matchLoginExpired).
 *
 *  The account's state outranks the buffer. A pane prints the limit sentence
 *  for reasons that are not the limit — replaying a past one, quoting it,
 *  writing about it (this feature was built in a pane that did all three) —
 *  and the badge it lights then stands for the whole window while the CLI
 *  answers normally right underneath it. So a reading that positively says
 *  quota remains vetoes the sentence. Only a positive one: an absent, stale
 *  or errored reading leaves the buffer as the only witness there is.
 *
 *  For some vendors that is the permanent state, and the boundary is not the
 *  one it looks like. It is not "has a quota command": cursor, kilo and pi all
 *  report usage, but in windows of kind cycle / on-demand / credits / period,
 *  and only session, weekly and monthly speak for the account (HEADLINE_KINDS).
 *  So for those three the reading never says anything either way and the
 *  buffer decides alone, exactly as it did before. */
export function detectUsageLimit(
  agentKey: string | undefined | null,
  tail: string,
  now: number = Date.now()
): UsageLimitHit | typeof QUOTA_READING_VETO | null {
  const clocked = matchSessionLimit(tail)
  if (clocked !== null) {
    if (hasHeadlineHeadroom(usageFor(agentKey))) return QUOTA_READING_VETO
    const parsed = parseLimitReset(clocked, now)
    return limitHit(agentKey, clocked, parsed ?? usageResumeAt(agentKey, now), now)
  }
  // The vendor's own declared notice (agents/<key>.ts quotaExhausted): its
  // exact words, so it is trusted like the clocked sentence — and vetoed by
  // the same positive reading. It names no window, so the reset comes from
  // the reading or stays unknown.
  const declared = AGENT_SPECS.find((s) => s.agentKey === agentKey)?.quotaExhausted?.pattern
  const own = declared ? declared.exec(tail.replace(/\s+/g, ' ')) : null
  if (own) {
    if (hasHeadlineHeadroom(usageFor(agentKey))) return QUOTA_READING_VETO
    return limitHit(agentKey, own[0], usageResumeAt(agentKey, now), now)
  }
  const bare = BARE_LIMIT_RE.exec(tail.replace(/\s+/g, ' '))
  if (!bare || exhaustedWindow(usageFor(agentKey)) === undefined) return null
  return limitHit(agentKey, bare[0], usageResumeAt(agentKey, now), now)
}
