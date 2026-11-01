// Quota-exhaustion failover, the pure half: what an exhaustion signal is, whom
// it belongs to, and which of the same vendor's other accounts is worth
// switching to and in what order.
//
// Advisory only. The backend is the authority on eligibility, the switch
// transaction, the tried set and the auto-switch budget; everything here is
// re-derived from inputs the caller hands in and returns a verdict the caller
// can show or send. Nothing in this module reads live state, keeps a budget or
// remembers what it answered last time — a renderer that did would become a
// second, per-window coordinator disagreeing with the backend.
//
// Three things it deliberately does NOT do:
//   - Treat "not exhausted" as "has quota". Every positive answer needs a
//     reading that measured the vendor's own quota windows (its declared
//     `quotaSemantics`, agents/<key>.ts) and found them under the line.
//   - Let the active provider's snapshot speak for every slot. A reading only
//     counts for the slot it names, under the credential epoch it was taken in.
//   - Promise recovery. A window whose reset time has passed is
//     "reset-expected": the account MAY be back, which ranks below a fresh
//     positive reading and never reads as "quota verified".

import { AGENT_SPECS } from '@navide/plugin-shell'
import type { AgentSpec } from '@navide/plugin-shell'
import { matchLoginExpired } from './cliLoginExpired'
import { LIMIT_RESET_BUFFER_MS, matchSessionLimit, parseLimitReset } from './loopPrompt'
import type { UsageSnapshot, UsageWindow } from '../composables/useUsage'

// ── Identity ────────────────────────────────────────────────────────────────

/** The backend's reserved id for the built-in Default account row, whose
 *  profile id is `null` on the renderer side. Every identity in this module
 *  is keyed on the slot id, so `null` is spelled out rather than lost. */
export const DEFAULT_SLOT_ID = '__default__'

/** A profile id as the backend keys it: the built-in Default is `null` to the
 *  renderer and `__default__` to every payload. */
export function slotIdOf(profileId: string | null | undefined): string {
  return profileId == null || profileId === '' ? DEFAULT_SLOT_ID : profileId
}

/** One account of one vendor under one authentication scope. `authScope` is
 *  whatever the vendor adapter says makes two credentials interchangeable
 *  (an org, a provider inside a multi-provider CLI, …); candidates outside the
 *  exhausted account's scope are never offered. */
export interface AccountRef {
  agentKey: string
  authScope: string
  slotId: string
}

// ── Vendor quota semantics ──────────────────────────────────────────────────

/** Which of a vendor's usage windows mean what — the shape each vendor
 *  declares as `quotaSemantics` in agents/<key>.ts, read here through the
 *  registry. A vendor without the declaration has no semantics: its reading
 *  can still show a spent window, but nothing may call it positive.
 *
 *  - `hard`: account-level limits. Any present one at 100% blocks the account.
 *  - `required`: hard windows a reading must contain to count as positive —
 *    a reading missing one says nothing about that limit ("missing window is
 *    unknown"), unless the reader proved it absent (`absentWindows`). Left out
 *    of `required` are windows the vendor only reports sometimes (kimi's 5h
 *    rate limit, cursor's on-demand pool).
 *  - `alternate`: a pool that keeps requests flowing when a hard window is
 *    spent (cursor on-demand). Headroom there lifts the spent hard window.
 *  - `scoped`: per-model buckets. Never a veto and never a positive — the
 *    same rule useUsage applies to `weekly-model`. */
export interface VendorQuotaSemantics {
  hard: readonly string[]
  required: readonly string[]
  alternate?: readonly string[]
  scoped?: readonly string[]
}

function specFor(agentKey: string): AgentSpec | undefined {
  return AGENT_SPECS.find((s) => s.agentKey === agentKey)
}

/** The vendor's declared semantics, or undefined for a vendor that declares
 *  none (per-model buckets like antigravity, per-provider stores like
 *  opencode, and the vendors with no usage fetcher). */
export function quotaSemanticsFor(agentKey: string): VendorQuotaSemantics | undefined {
  return specFor(agentKey)?.quotaSemantics
}

/** The vendor's own exhaustion notice, when it has declared one. */
export function quotaExhaustedPatternFor(agentKey: string): RegExp | undefined {
  return specFor(agentKey)?.quotaExhausted?.pattern
}

/** A window as the backend actually ships it: `credits` windows carry the
 *  datum the percentage cannot (kilo's raw balance, pi's usage/limit). */
export interface QuotaWindowReading extends UsageWindow {
  balance?: number | null
  usage?: number | null
  limit?: number | null
}

/** A window counts as spent at this figure; the backend clamps to 100. */
export const EXHAUSTED_USED_PCT = 100

/** Remaining headroom of one window, or null when the window cannot say
 *  (an uncapped credit pool reports usage but no limit). */
export function windowRemaining(w: QuotaWindowReading): number | null {
  // Only finite numbers are evidence: a NaN balance would read as spent and
  // an Infinity limit as headroom, and neither was measured.
  if (w.balance !== undefined && w.balance !== null) {
    if (!Number.isFinite(w.balance)) return null
    // A prepaid balance has no percentage; the sign is the whole answer.
    return w.balance > 0 ? 100 : 0
  }
  if (w.kind === 'credits') {
    if (!(Number.isFinite(w.limit) && (w.limit as number) > 0)) return null
    if (w.usage !== undefined && w.usage !== null) {
      if (!Number.isFinite(w.usage) || w.usage < 0) return null
      return Math.max(0, Math.min(100, 100 - 100 * w.usage / (w.limit as number)))
    }
  }
  if (!Number.isFinite(w.usedPercent) || w.usedPercent < 0) return null
  return Math.max(0, Math.min(100, 100 - w.usedPercent))
}

/** How a reading answers for one account. `positive` is the only value that
 *  can rank an account as having quota; `spent` lists the hard windows the
 *  reading found at the line; `unknown` are required windows it lacked. */
export interface QuotaReadingVerdict {
  positive: boolean
  spent: QuotaWindowReading[]
  missing: string[]
  /** Headroom of the tightest hard window, or null when none was measured. */
  weakestRemaining: number | null
  /** Headroom per hard window the reading could measure. */
  measured: ReadonlyMap<string, number>
}

function isCurrentReading(snap: UsageSnapshot | null | undefined): snap is UsageSnapshot {
  if (!snap || snap.status !== 'ok') return false
  return !snap.stale && !snap.staleExpired && !snap.refreshPending
}

/** Judge a snapshot by the vendor's semantics. Pure over the windows: whether
 *  the reading is current, whose it is and how old it is are the caller's
 *  facts, checked in rankCandidates. */
export function judgeReading(
  snap: UsageSnapshot | null | undefined,
  semantics: VendorQuotaSemantics | undefined,
  now?: number,
): QuotaReadingVerdict {
  const none: QuotaReadingVerdict = { positive: false, spent: [], missing: [], weakestRemaining: null, measured: new Map() }
  if (!snap || snap.status !== 'ok') return none
  // A reset that passed is only an expectation, never a new measurement.
  // Historical ranking omits the clock and judges its reset ledger separately.
  const windows = (snap.windows as QuotaWindowReading[]).filter((w) => !w.expired &&
    !(now !== undefined && w.resetsAt && Date.parse(w.resetsAt) <= now))
  const present = new Set(windows.map((w) => w.kind))
  const scoped = new Set(semantics?.scoped ?? [])
  // Without declared semantics every non-scoped window is taken as hard: a
  // spent one still blocks, but nothing can be positive (`required` unknown).
  const hard = semantics ? new Set(semantics.hard) : null
  const hardWindows = windows.filter((w) => (hard ? hard.has(w.kind) : !scoped.has(w.kind)))
  const spent = hardWindows.filter((w) => {
    const remaining = windowRemaining(w)
    return remaining !== null && remaining <= 100 - EXHAUSTED_USED_PCT
  })
  const alternate = new Set(semantics?.alternate ?? [])
  const alternateOpen = windows.some((w) => alternate.has(w.kind) && (windowRemaining(w) ?? 0) > 0)
  const effectiveSpent = alternateOpen ? [] : spent
  const measured = new Map<string, number>()
  for (const w of hardWindows) {
    const remaining = windowRemaining(w)
    if (remaining === null) continue
    const prior = measured.get(w.kind)
    measured.set(w.kind, prior === undefined ? remaining : Math.min(prior, remaining))
  }
  const weakestRemaining = measured.size > 0 ? Math.min(...measured.values()) : null
  if (!semantics) return { positive: false, spent: effectiveSpent, missing: [], weakestRemaining, measured }
  const absent = new Set(snap.absentWindows)
  const missing = semantics.required.filter((kind) => !present.has(kind) && !absent.has(kind))
  const positive =
    missing.length === 0 &&
    effectiveSpent.length === 0 &&
    measured.size > 0 &&
    hardWindows.every((w) => windowRemaining(w) !== null)
  return { positive, spent: effectiveSpent, missing, weakestRemaining, measured }
}

// ── Failure classification ──────────────────────────────────────────────────

/** What a failure in a pane or an API reply actually was. Only
 *  `quota-exhausted` may start a switch; everything else is routed elsewhere
 *  (a retry, a login, a shorter prompt, a billing page) and must not burn the
 *  auto-switch budget or brand an account as spent. */
export type FailureCause =
  | 'quota-exhausted'
  | 'rate-limited'
  | 'auth'
  | 'network'
  | 'context'
  | 'payment'
  | 'low-quota-warning'
  | 'unknown'

export interface FailureSignal {
  agentKey: string
  /** Pane output, whitespace-collapsed by the classifier. */
  text?: string | null
  /** When the text was observed (epoch ms). Lets a reading be ordered
   *  against it: only a reading taken AFTER the text can overrule it. */
  observedAt?: number | null
  httpStatus?: number | null
  /** A vendor error code (`insufficient_quota`, `rate_limit_exceeded`, …). */
  errorCode?: string | null
  /** The account's own reading, when the caller has one: a bare "hit your
   *  limit" phrase is only a quota hit when the reading agrees. */
  reading?: UsageSnapshot | null
  /** Overrides the vendor's declared `quotaExhausted.pattern` (agents/<key>.ts),
   *  the only free text — besides Claude's clocked sentence — that counts as
   *  explicit. Normally left out so the spec's declaration is used. */
  vendorLimitPattern?: RegExp | null
}

export interface FailureVerdict {
  cause: FailureCause
  /** `explicit`: a structured code / status, the vendor's own declared
   *  pattern, or (Claude only) the clocked limit sentence. `corroborated`: a
   *  phrase backed by the account's reading. `weak`: wording alone — enough
   *  to notify, never to switch. Generic text is weak whatever it says: a
   *  CLI's transcript quotes and discusses these sentences all the time. */
  confidence: 'explicit' | 'corroborated' | 'weak'
  /** The reset the message itself stated (no buffer), or null. */
  resetAt: number | null
  matched: string | null
}

const PAYMENT_RE =
  /(insufficient[_ ](credits|funds|balance|quota)|payment[_ ]required|billing (issue|problem|hard limit)|add (more )?credits|purchase (more )?credits|top up your|credit balance is too low)/i
const AUTH_RE =
  /(login expired|not logged in|please (run|use) \/?login|unauthori[sz]ed|invalid (api[_ ]key|token|credentials)|authentication (failed|error|required)|token (has )?expired|re-?authenticate|access denied)/i
const CONTEXT_RE =
  /(context window|prompt is too long|too many tokens|exceeds? the (maximum )?context|maximum context length|context length exceeded|input is too long)/i
const NETWORK_RE =
  /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network error|fetch failed|connection (was )?(reset|refused|timed out|closed)|socket hang up|dns (lookup|resolution) failed|unable to connect|no internet)/i
const QUOTA_EXPLICIT_RE =
  /(usage limit reached|quota (has been )?exhausted|out of quota|exceeded your (current |usage |plan )?(quota|usage limit)|(weekly|monthly|daily|session|plan|usage) limit (has been )?reached|reached your (weekly|monthly|daily|session|usage|plan) limit|(you'?ve|you have) used (all|100%) of your|no (remaining )?quota (left|remaining)|quota limit exceeded)/i
const QUOTA_BARE_RE = /hit your .{0,40}limit/i
const RATE_RE =
  /(rate[- ]limit(ed|s)?|too many requests|slow down|retry[- ]after|overloaded|temporarily unavailable|try again (later|in a)|server is busy)/i
const LOW_QUOTA_RE =
  /(\b\d{1,2}% (of your )?(usage|quota)[^.]{0,30}(left|remaining)|approaching your (usage )?limit|running low on (credits|quota)|nearly out of (credits|quota))/i

const QUOTA_CODES = new Set(['quota_exhausted', 'usage_limit_reached', 'usage_limit', 'quota_exceeded', 'plan_limit_reached'])
const PAYMENT_CODES = new Set(['insufficient_quota', 'insufficient_funds', 'payment_required', 'billing_hard_limit_reached'])
const RATE_CODES = new Set(['rate_limit_exceeded', 'rate_limited', 'overloaded_error', 'too_many_requests'])
const AUTH_CODES = new Set(['invalid_api_key', 'authentication_error', 'unauthorized', 'permission_error', 'token_expired', 'invalid_token'])
const CONTEXT_CODES = new Set(['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long'])

function readingSaysSpent(agentKey: string, reading: UsageSnapshot | null | undefined): boolean {
  if (!isCurrentReading(reading)) return false
  return judgeReading(reading, quotaSemanticsFor(agentKey)).spent.length > 0
}

function readingSaysHeadroom(agentKey: string, reading: UsageSnapshot | null | undefined): boolean {
  if (!isCurrentReading(reading)) return false
  return judgeReading(reading, quotaSemanticsFor(agentKey)).positive
}

/** True when the reading was taken after the text was observed. A reading
 *  polled a quarter of an hour ago is `status: ok, stale: false` and still
 *  older than a banner printed just now; without an order it cannot overrule
 *  anything the vendor said explicitly. */
function readingNewerThan(reading: UsageSnapshot | null | undefined, observedAt: number | null | undefined): boolean {
  if (!reading || observedAt == null || !Number.isFinite(observedAt)) return false
  const fetched = Date.parse(reading.fetchedAt)
  return Number.isFinite(fetched) && fetched > observedAt
}

/** True when a verdict may start an automatic switch: an exhaustion the
 *  vendor declared or the reading backs. Weak wording only notifies. */
export function canTriggerAutoSwitch(verdict: FailureVerdict): boolean {
  return verdict.cause === 'quota-exhausted' && verdict.confidence !== 'weak'
}

/** Classify one failure. Precedence is by specificity: a code or a sentence
 *  that names billing, login or the context window wins over the words "limit"
 *  or "429" that often sit beside it; a bare 429 is a short rate limit unless
 *  something says quota. */
export function classifyFailure(signal: FailureSignal, now: number = Date.now()): FailureVerdict {
  const text = (signal.text ?? '').replace(/\s+/g, ' ')
  const code = (signal.errorCode ?? '').trim().toLowerCase()
  const status = signal.httpStatus ?? null
  const verdict = (cause: FailureCause, confidence: FailureVerdict['confidence'], matched: string | null = null): FailureVerdict => ({
    cause,
    confidence,
    resetAt: null,
    matched,
  })

  if (PAYMENT_CODES.has(code) || status === 402) return verdict('payment', 'explicit', code || String(status))
  if (AUTH_CODES.has(code) || status === 401) return verdict('auth', 'explicit', code || String(status))
  if (CONTEXT_CODES.has(code)) return verdict('context', 'explicit', code)
  if (QUOTA_CODES.has(code)) return verdict('quota-exhausted', 'explicit', code)
  if (RATE_CODES.has(code)) return verdict('rate-limited', 'explicit', code)

  if (text) {
    const payment = PAYMENT_RE.exec(text)
    if (payment) return verdict('payment', 'explicit', payment[0])
    if (matchLoginExpired(signal.agentKey, text)) return verdict('auth', 'explicit', 'login-expired')
    const auth = AUTH_RE.exec(text)
    if (auth) return verdict('auth', 'explicit', auth[0])
    const context = CONTEXT_RE.exec(text)
    if (context) return verdict('context', 'explicit', context[0])

    // The account's reading and the text are two witnesses; which one wins
    // depends on which is newer. A positive reading taken AFTER the text
    // makes any limit sentence prose — quoted, replayed, or written about
    // (the detectUsageLimit rule). One taken BEFORE it says nothing about
    // the wall the vendor just announced: the poll simply has not caught up.
    // Generic wording never rises above weak on a positive reading of any
    // age; only a spent reading can lift it to corroborated.
    const headroom = readingSaysHeadroom(signal.agentKey, signal.reading)
    const spent = readingSaysSpent(signal.agentKey, signal.reading)
    const overruled = headroom && readingNewerThan(signal.reading, signal.observedAt)
    const quota = (matched: string, declared: boolean): FailureVerdict => {
      if (overruled) return verdict('unknown', 'weak', matched)
      if (declared) return verdict('quota-exhausted', 'explicit', matched)
      if (headroom) return verdict('unknown', 'weak', matched)
      return verdict('quota-exhausted', spent ? 'corroborated' : 'weak', matched)
    }
    // The clocked sentence is Claude Code's own; it names its reset, and
    // that reset is the only part that says WHICH window ran out. For any
    // other vendor the same words are just words.
    const clocked = signal.agentKey === 'claude' ? matchSessionLimit(text) : null
    if (clocked) {
      const parsed = parseLimitReset(clocked, now)
      return {
        ...quota(clocked, true),
        resetAt: overruled || parsed === null ? null : parsed - LIMIT_RESET_BUFFER_MS,
      }
    }
    const declared = signal.vendorLimitPattern ?? quotaExhaustedPatternFor(signal.agentKey) ?? null
    if (declared) {
      const vendor = declared.exec(text)
      if (vendor) return quota(vendor[0], true)
    }
    const explicit = QUOTA_EXPLICIT_RE.exec(text)
    if (explicit) return quota(explicit[0], false)
    const low = LOW_QUOTA_RE.exec(text)
    if (low) return verdict('low-quota-warning', 'weak', low[0])
    const bare = QUOTA_BARE_RE.exec(text)
    if (bare) return spent ? verdict('quota-exhausted', 'corroborated', bare[0]) : verdict('unknown', 'weak', bare[0])
    const rate = RATE_RE.exec(text)
    if (rate) return verdict('rate-limited', status === 429 ? 'explicit' : 'weak', rate[0])
    const network = NETWORK_RE.exec(text)
    if (network) return verdict('network', 'explicit', network[0])
  }

  if (status === 429) return verdict('rate-limited', 'weak', '429')
  if (status === 403) return verdict('auth', 'weak', '403')
  if (status === 502 || status === 503 || status === 504 || status === 529) return verdict('rate-limited', 'weak', String(status))
  return verdict('unknown', 'weak')
}

// ── Exhaustion evidence ─────────────────────────────────────────────────────

export type EvidenceSource = 'pane-text' | 'usage-reading' | 'backend'

/** One observation that an account ran out, attributed to the account that
 *  was active WHEN IT WAS OBSERVED — not to whoever is default now. */
export interface ExhaustionEvidence extends AccountRef {
  /** Credential epoch the observing pane / poll was running under, or null
   *  when the source cannot say (then it is never attributable). */
  epoch: number | null
  paneId: string | null
  sessionId: string | null
  source: EvidenceSource
  observedAt: number
  cause: FailureCause
  /** The window the signal named, when it named one. */
  windowKind: string | null
  /** When that window said it resets, or null. */
  resetAt: number | null
}

/** Evidence can start or join an incident only when it is a quota hit that
 *  belongs to the account and epoch the caller is currently on. A late signal
 *  from a pane still on the previous credentials describes the OLD account,
 *  and must not be pinned on the new default. */
export function evidenceIsAttributable(
  evidence: ExhaustionEvidence,
  current: { slotId: string; epoch: number; authScope: string },
): boolean {
  if (evidence.cause !== 'quota-exhausted') return false
  if (evidence.epoch === null) return false
  return (
    evidence.epoch === current.epoch &&
    evidence.slotId === current.slotId &&
    evidence.authScope === current.authScope
  )
}

/** Resets within this distance are the same window: the same banner is
 *  re-parsed against each poll's clock and lands seconds apart. */
export const RESET_MATCH_TOLERANCE_MS = 60_000

/** The key under which observations of the same exhaustion collapse into one
 *  incident: same account, same epoch, and — when the signal named a reset —
 *  the same reset (bucketed to the tolerance). Several panes hitting the same
 *  wall produce one key; a new hit after the reset produces another. */
export function incidentKeyFor(evidence: ExhaustionEvidence): string {
  const reset = evidence.resetAt === null ? '-' : String(Math.round(evidence.resetAt / RESET_MATCH_TOLERANCE_MS))
  return [evidence.agentKey, evidence.authScope, evidence.slotId, evidence.epoch ?? '-', evidence.windowKind ?? '-', reset].join('|')
}

// ── Candidate ranking ───────────────────────────────────────────────────────

export type LoginState = 'signed-in' | 'signed-out' | 'expired' | 'login-pending' | 'unknown'

/** A reading, attributed. The snapshot alone cannot say whose it is — the
 *  provider-level one the backend publishes belongs to whoever is active — so
 *  a candidate's reading is only used when it names the candidate's own slot. */
export interface AccountReading {
  slotId: string
  /** Credential epoch the reading was taken under; null for a legacy reading
   *  that predates epochs (never fresh). */
  epoch: number | null
  observedAt: number
  snapshot: UsageSnapshot
}

/** A hard window this slot was seen to run out of, and when it was expected
 *  back. The exhaustion ledger (tokens.quota_cycles) is one source; a pane's
 *  own detection is another. `resetsAt` null means nobody knows. */
export interface ExhaustedWindowRecord {
  kind: string
  exhaustedAt: number
  resetsAt: number | null
}

export interface CandidateAccount {
  slotId: string
  authScope: string
  login: LoginState
  reading?: AccountReading | null
  exhaustedWindows?: readonly ExhaustedWindowRecord[]
}

export interface RankingContext {
  agentKey: string
  /** The exhausted account. */
  authScope: string
  currentSlotId: string
  currentEpoch: number
  /** Slots this incident already tried; the backend owns the set. */
  triedSlotIds: readonly string[]
  now: number
  /** A reading older than this is `stale-headroom` at best. */
  freshWithinMs?: number
  /** Override the vendor table (tests, or a spec-declared model). */
  semantics?: VendorQuotaSemantics
}

/** A reading is fresh for this long. Claude's own read runs on a 15-minute
 *  cooldown; twice that tolerates one missed poll without letting an hour-old
 *  figure pass for the present. */
export const DEFAULT_FRESH_WINDOW_MS = 30 * 60_000

export type CandidateTier = 'fresh-headroom' | 'reset-expected' | 'stale-headroom' | 'unknown'

export type ExclusionReason =
  | 'current'
  | 'signed-out'
  | 'expired'
  | 'login-pending'
  | 'limit-not-reset'
  | 'tried'
  | 'wrong-scope'

const TIER_ORDER: Record<CandidateTier, number> = {
  'fresh-headroom': 0,
  'reset-expected': 1,
  'stale-headroom': 2,
  unknown: 3,
}

export interface RankedCandidate {
  slotId: string
  tier: CandidateTier
  /** `signed-in` or `unknown`; every other state was excluded. An unknown
   *  login can be offered to the user, never to the automatic path. */
  login: 'signed-in' | 'unknown'
  /** Headroom of the tightest measured hard window (fresh / stale tiers). */
  weakestRemaining: number | null
  /** When the reading behind the tier was taken (fresh / stale tiers). */
  observedAt: number | null
  /** Latest reset among the windows that were spent (reset-expected tier). */
  resetPassedAt: number | null
  /** Required windows the reading lacked — why a current reading is not fresh. */
  missingWindows: string[]
}

export interface ExcludedCandidate {
  slotId: string
  reason: ExclusionReason
  /** For `limit-not-reset`: the windows still spent and the latest reset
   *  known for them (null when none is known). */
  spentWindows: string[]
  resetExpectedAt: number | null
}

export interface CandidateRanking {
  eligible: RankedCandidate[]
  excluded: ExcludedCandidate[]
}

interface SpentState {
  kinds: string[]
  /** Latest known reset among the still-spent windows; null when one has no
   *  reset at all (then it never counts as passed). */
  blockingUntil: number | null
  /** True when at least one spent window is known and every one has reset. */
  allReset: boolean
  latestReset: number | null
}

/** Combine what a reading and the exhaustion history say is spent. A window
 *  is still spent when its reset lies ahead or is unknown. A record is
 *  superseded when a CURRENT reading taken after it measured that window and
 *  found headroom; a reading that did not measure the window says nothing
 *  about it, and the record stands. */
function spentState(
  candidate: CandidateAccount,
  verdict: QuotaReadingVerdict,
  measured: ReadonlyMap<string, number> | null,
  readingObservedAt: number | null,
  now: number,
): SpentState {
  const spent = new Map<string, number | null>()
  for (const record of candidate.exhaustedWindows ?? []) {
    const remeasured =
      measured !== null &&
      readingObservedAt !== null &&
      readingObservedAt >= record.exhaustedAt &&
      (measured.get(record.kind) ?? 0) > 0
    if (remeasured) continue
    const existing = spent.get(record.kind)
    if (existing === undefined || (record.resetsAt ?? Infinity) > (existing ?? Infinity)) {
      spent.set(record.kind, record.resetsAt)
    }
  }
  for (const w of verdict.spent) {
    const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN
    const reset = Number.isFinite(at) ? at : null
    // Two witnesses to the same spent window: keep the more conservative
    // one. A snapshot whose reset has passed does not lift a ledger record
    // that says the window is still out (or that nobody knows when it is
    // back) — the snapshot may simply be older.
    const existing = spent.get(w.kind)
    if (existing === undefined) spent.set(w.kind, reset)
    else if (existing === null || reset === null) spent.set(w.kind, null)
    else spent.set(w.kind, Math.max(existing, reset))
  }
  const kinds = [...spent.keys()].sort()
  let blocked = false
  let blockingUntil: number | null = null
  let latestReset: number | null = null
  let unknownReset = false
  for (const reset of spent.values()) {
    if (reset === null) {
      blocked = true
      unknownReset = true
      continue
    }
    latestReset = latestReset === null ? reset : Math.max(latestReset, reset)
    if (reset > now) {
      blocked = true
      blockingUntil = blockingUntil === null ? reset : Math.max(blockingUntil, reset)
    }
  }
  return {
    kinds,
    blockingUntil: unknownReset ? null : blockingUntil,
    allReset: kinds.length > 0 && !blocked,
    latestReset,
  }
}

function loginExclusion(login: LoginState): ExclusionReason | null {
  switch (login) {
    case 'signed-out':
      return 'signed-out'
    case 'expired':
      return 'expired'
    case 'login-pending':
      return 'login-pending'
    default:
      return null
  }
}

/** A sort key that is never NaN: a comparator returning NaN makes the sort
 *  order depend on the input order. */
function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  const tier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier]
  if (tier !== 0) return tier
  // Within a tier: more headroom in the weakest window first, then the newer
  // reading, then the earlier-passed reset, then the slot id — every key is a
  // fact about the candidate, so two runs over the same inputs agree.
  const headroom = finiteOr(b.weakestRemaining, -1) - finiteOr(a.weakestRemaining, -1)
  if (headroom !== 0) return headroom
  const observed = finiteOr(b.observedAt, -1) - finiteOr(a.observedAt, -1)
  if (observed !== 0) return observed
  const reset = finiteOr(a.resetPassedAt, Number.MAX_SAFE_INTEGER) - finiteOr(b.resetPassedAt, Number.MAX_SAFE_INTEGER)
  if (reset !== 0) return reset
  return a.slotId < b.slotId ? -1 : a.slotId > b.slotId ? 1 : 0
}

/** Rank the vendor's other accounts for a switch away from `currentSlotId`.
 *
 *  Excluded first, in the order the plan lists them — the current account,
 *  anything not signed in, anything with a hard limit still standing, anything
 *  this incident already tried, anything outside the auth scope — then the
 *  survivors by tier:
 *    fresh-headroom  a current reading of this slot under the current epoch,
 *                    every required window present, none spent
 *    reset-expected  every spent window's reset has passed, no fresh positive
 *    stale-headroom  a positive reading that is stale, old or from an earlier
 *                    epoch
 *    unknown         signed in, no usable reading
 *  A slot whose weekly window is spent stays excluded however long ago its 5h
 *  window reset: `limit-not-reset` is per window and any one standing vetoes. */
export function rankCandidates(ctx: RankingContext, candidates: readonly CandidateAccount[]): CandidateRanking {
  const semantics = ctx.semantics ?? quotaSemanticsFor(ctx.agentKey)
  const freshWithin = ctx.freshWithinMs ?? DEFAULT_FRESH_WINDOW_MS
  const tried = new Set(ctx.triedSlotIds)
  const eligible: RankedCandidate[] = []
  const excluded: ExcludedCandidate[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    if (seen.has(candidate.slotId)) continue
    seen.add(candidate.slotId)
    const exclude = (reason: ExclusionReason, spent: SpentState | null = null): void => {
      excluded.push({
        slotId: candidate.slotId,
        reason,
        spentWindows: spent?.kinds ?? [],
        resetExpectedAt: spent?.blockingUntil ?? null,
      })
    }
    if (candidate.slotId === ctx.currentSlotId) {
      exclude('current')
      continue
    }
    if (candidate.authScope !== ctx.authScope) {
      exclude('wrong-scope')
      continue
    }
    const login = loginExclusion(candidate.login)
    if (login) {
      exclude(login)
      continue
    }

    // A reading only speaks for the slot it names. The provider-level snapshot
    // (whoever is active) handed in for a parked slot is discarded here, not
    // trusted — the cheapest way to turn every parked account "healthy".
    const reading = candidate.reading && candidate.reading.slotId === candidate.slotId ? candidate.reading : null
    const snapshot = reading?.snapshot ?? null
    const readingStatus = snapshot?.status ?? null
    if (readingStatus === 'no-credentials') {
      exclude('signed-out')
      continue
    }
    if (readingStatus === 'expired') {
      exclude('expired')
      continue
    }
    const verdict = judgeReading(snapshot, semantics)
    const current = isCurrentReading(snapshot)
    const observedAt = reading?.observedAt ?? null
    const spent = spentState(candidate, verdict, current ? verdict.measured : null, current ? observedAt : null, ctx.now)
    if (spent.kinds.length > 0 && !spent.allReset) {
      exclude('limit-not-reset', spent)
      continue
    }
    if (tried.has(candidate.slotId)) {
      exclude('tried')
      continue
    }

    // A reading is fresh only under the current epoch and with a finite,
    // non-negative age: a timestamp from the future (clock skew, a bad
    // payload) is not "just now", it is not a time at all.
    const age = reading === null ? NaN : ctx.now - reading.observedAt
    const fresh =
      current &&
      reading !== null &&
      reading.epoch === ctx.currentEpoch &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= freshWithin
    let tier: CandidateTier
    if (verdict.positive && fresh) tier = 'fresh-headroom'
    else if (spent.allReset) tier = 'reset-expected'
    else if (verdict.positive) tier = 'stale-headroom'
    else tier = 'unknown'
    eligible.push({
      slotId: candidate.slotId,
      tier,
      login: candidate.login === 'signed-in' ? 'signed-in' : 'unknown',
      weakestRemaining: tier === 'fresh-headroom' || tier === 'stale-headroom' ? verdict.weakestRemaining : null,
      observedAt: tier === 'fresh-headroom' || tier === 'stale-headroom' ? observedAt : null,
      resetPassedAt: tier === 'reset-expected' ? spent.latestReset : null,
      missingWindows: verdict.missing,
    })
  }

  eligible.sort(compareRanked)
  return { eligible, excluded }
}

/** The one candidate an automatic switch may propose, or null.
 *
 *  Only a verified sign-in qualifies: "login unknown" is a slot nobody has
 *  looked at, and the automatic path must not find out by switching to it.
 *  An `unknown`-tier candidate (signed in, no reading) is allowed at most
 *  once per incident — it has credentials, not quota — so once one has been
 *  tried the round ends rather than walk the list. This is a proposal: the
 *  backend re-checks login, scope and budget inside its own lock. */
export function pickAutoCandidate(
  ranking: CandidateRanking,
  opts: { unknownAttempted: boolean } = { unknownAttempted: false },
): RankedCandidate | null {
  const first = ranking.eligible.find((c) => c.login === 'signed-in')
  if (!first) return null
  if (first.tier === 'unknown' && opts.unknownAttempted) return null
  return first
}

/** The distinct reasons nothing was offered, for a notification that says
 *  "sign in / wait for the reset / no reading" instead of "all exhausted". */
export function noCandidateReasons(ranking: CandidateRanking): ExclusionReason[] {
  const reasons = new Set<ExclusionReason>()
  for (const item of ranking.excluded) {
    if (item.reason !== 'current') reasons.add(item.reason)
  }
  return [...reasons].sort()
}
