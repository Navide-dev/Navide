import { ref, watch, type Ref } from 'vue'
import type { useBackend } from './useBackend'
import { useAnnouncements, type QuotaAnnouncementAction, type QuotaCandidateOffer, type QuotaExcludedOffer, type QuotaIncidentNotice, type QuotaIncidentStatus } from './useAnnouncements'
import type { CandidateTier } from '../lib/quotaFailover'

// Quota-exhaustion failover, the renderer's half of the `quota_failover.*`
// contract. The backend (quota_failover.py) is the authority: it attributes
// every report, ranks candidates, holds the policy, the tried set and the
// automatic budget, and runs the switch transaction. This module only
//
//   - reports what a pane saw (`report`), proposes what the user clicked
//     (`switch`, `confirm`, `cancel`) and the policy they chose (`setPolicy`);
//   - answers `prepare` for the panes THIS window owns — is each one at a turn
//     boundary with a resumable session? — and re-answers when a busy one
//     reaches one, so a switch waits instead of stopping work;
//   - acts on `commit` exactly once per (transaction, pane): restarts the
//     listed panes through the app's resume path when the strategy says so,
//     and reports each outcome (`settle`); it sends no prompt, no "continue"
//     and no loop resume after the switch — that is the user's button;
//   - mirrors incidents into the announcements feed with the epoch every
//     button must carry back.
//
// Module-level singleton, like useUsage: App.vue wires it once; anything else
// reads `state`.

export type FailoverMode = 'off' | 'notify' | 'auto'
export type FailoverSwitchMode = 'hot' | 'restart' | 'manual' | 'unsupported'
export type FailoverRestartStrategy = 'none' | 'resume' | 'new-conversation'

export interface FailoverCapability {
  agentKey: string
  supported: boolean
  switchMode: FailoverSwitchMode
  authScope: string
  /** How the adapter was established. "source" / "docs" is information —
   *  not verified on this build — never a reason to disable the vendor. */
  evidence: 'live' | 'source' | 'docs' | null
  resume: 'native' | 'lossy' | 'none'
  /** How a sign-in reaches the vendor: "isolated" (private home, live
   *  credential untouched) or "global" (the live credential is replaced for
   *  the duration). Same value as cli_profiles.list's account_capabilities. */
  loginIsolation?: 'isolated' | 'global'
  scopes: string[]
  platforms?: string[]
  verifiedVersion?: string
  hasSlots: boolean
  todo: string
}

export interface FailoverBudget {
  agentKey: string
  authScope: string
  used: number
  limit: number
  windowSec: number
  minGapSec: number
  nextAllowedAt: string | null
}

export type FailoverIncidentState = 'detected' | 'waiting-safe' | 'switching' | 'settling' | 'ready' | 'notify-stopped'

export interface FailoverIncident {
  id: string
  agentKey: string
  authScope: string
  outgoingSlotId: string
  epoch: number
  state: FailoverIncidentState
  reason: string | null
  trusted: boolean
  attribution: 'pane-history' | 'single-account' | 'unknown' | 'manual'
  autoAllowed: boolean
  tried: string[]
  panes: { paneId: string; workspacePath: string }[]
  transactionIds: string[]
  detectedAt: string
  resetsAt: string | null
  windowKind: string | null
  closedAt: string | null
  updatedAt: string
}

export interface FailoverTransactionPane {
  paneId: string
  termId: string
  agentKey: string
  workspacePath: string
  ack: null | 'ready' | 'busy' | 'refused'
  ackReason: string | null
  settle: null | 'resumed' | 'failed' | 'new-conversation'
  settleReason: string | null
  sessionId?: string
  newPaneId?: string
  newTermId?: string
  newSessionId?: string
}

export type FailoverTransactionState =
  | 'awaiting-confirmation'
  | 'preparing'
  | 'waiting-safe'
  | 'committed'
  | 'cancelled'
  | 'failed'
  | 'partial'

export interface HotSwitchedPane {
  paneId: string
  termId: string
  profileId: string | null
}

export interface FailoverTransaction {
  id: string
  incidentId: string
  agentKey: string
  authScope: string
  fromSlotId: string
  toSlotId: string
  automatic: boolean
  idempotencyKey: string
  switchMode: FailoverSwitchMode
  restartStrategy: FailoverRestartStrategy
  confirmation: 'none' | 'required' | 'confirmed'
  state: FailoverTransactionState
  reason: string | null
  error: string | null
  swapped: boolean
  epochBefore: number
  epochAfter: number | null
  panes: FailoverTransactionPane[]
  /** Panes whose credential comes from their environment: the swap cannot
   *  reach them, so they are neither restarted nor counted as switched. */
  overriddenPanes?: string[]
  hotSwitchedPanes?: HotSwitchedPane[]
  /** What the vault saw live when it refused (live-drift): display only. */
  liveIdentity?: { email?: string | null; signedIn?: boolean } | null
  /** live-drift-unverified: digest of the live credential the refusal saw
   *  (HMAC, not a secret, never shown). A confirmed resend hands it back
   *  verbatim; the backend honours the assumption only while the live
   *  credential still matches. Absent = no resend. */
  liveFingerprint?: string | null
  createdAt: string
  committedAt: string | null
  closedAt: string | null
}

/** A switch whose credentials moved but whose bookkeeping did not (or was
 *  interrupted). Every switch for the vendor is refused until the user
 *  reconciles it; `liveSlotId` null means the backend cannot tell which of
 *  the two accounts is live and the user has to say. */
export interface FailoverUnreconciled {
  transactionId: string
  agentKey: string
  authScope: string
  fromSlotId: string
  toSlotId: string
  liveSlotId: string | null
  reason: 'default-persist-failed' | 'interrupted-swap'
}

export interface FailoverState {
  policy: { mode: FailoverMode; updatedAt: string | null }
  auditDegraded?: string | null
  unreconciled?: Record<string, FailoverUnreconciled>
  capabilities: Record<string, FailoverCapability>
  budget: Record<string, FailoverBudget>
  epochs: Record<string, number>
  /** Open incidents, plus — when the backend keeps them — recently closed
   *  ones (closedAt set), so a finished switch stays visible with its result. */
  incidents: FailoverIncident[]
  recentIncidents?: FailoverIncident[]
  transactions: FailoverTransaction[]
  recentTransactions?: FailoverTransaction[]
}

export interface FailoverCandidate {
  slotId: string
  tier: CandidateTier
  loginState: 'ok' | 'signed-out' | 'expired' | 'login-pending'
  excluded: null | 'current' | 'tried' | 'signed-out' | 'expired' | 'login-pending' | 'exhausted'
  headroom: number | null
  fetchedAt: string | null
}

export interface PrepareEventPane {
  paneId: string
  /** Explicit retry may act on a replacement while retaining the tx key. */
  originalPaneId?: string
  termId: string
  agentKey: string
  workspacePath: string
}

export interface PrepareEvent {
  transactionId: string
  incidentId: string
  agentKey: string
  authScope: string
  fromSlotId: string
  toSlotId: string
  restartStrategy: FailoverRestartStrategy
  automatic: boolean
  deadlineAt: string
  panes: PrepareEventPane[]
}

export interface CommitEvent {
  hotSwitchedPanes?: HotSwitchedPane[]
  transactionId: string
  incidentId: string
  agentKey: string
  authScope: string
  fromSlotId: string
  toSlotId: string
  epoch: number | null
  switchMode: FailoverSwitchMode
  restartStrategy: FailoverRestartStrategy
  state: 'committed' | 'partial'
  needsLogin: boolean
  needsLoginReason: string | null
  panes: PrepareEventPane[]
}

/** What a pane answers to `prepare`. `ready` is a positive claim: the pane is
 *  at a turn boundary (not merely silent) and, when the switch will restart
 *  it, names the session it can be brought back on. */
export type PaneReadiness =
  | { ready: true; sessionId: string | null; resumable: boolean }
  | { ready: false; reason: 'busy' | 'no-session' | 'not-resumable' | 'unsupported' | 'refused' | 'input-pending' | 'permission-pending' }

export type RestartOutcome =
  | { outcome: 'resumed'; paneId: string; termId: string | null; sessionId: string | null }
  | { outcome: 'new-conversation'; paneId: string; termId: string | null }
  | { outcome: 'failed'; reason: string }

export interface QuotaFailoverHooks {
  ownsPane(paneId: string): boolean
  /** May probe (a session-on-disk check is a backend round trip). */
  paneReadiness(paneId: string, opts: { needsResume: boolean }): PaneReadiness | Promise<PaneReadiness>
  /** Stop the pane and bring it back on its conversation (the app's resume
   *  rebuild). Must not type anything into the new pane. */
  restartPane(pane: PrepareEventPane, ev: CommitEvent): Promise<RestartOutcome>
  /** Keep the old pane and open a fresh conversation beside it. */
  openNewConversation(pane: PrepareEventPane, ev: CommitEvent): Promise<RestartOutcome>
  /** The user's explicit consent for a switch that cannot resume. */
  confirmNewConversation(tx: FailoverTransaction): Promise<boolean>
  /** The user vouching that an unverifiable live-credential change is still
   *  the current account (a token refresh), for a MANUAL switch only. */
  confirmLiveIsCurrent(agentKey: string, currentSlotId: string, targetSlotId: string): Promise<boolean>
  paneTermId(paneId: string): string | null
  /** The CLI session the pane runs on (its resume id), or null. */
  paneSessionId(paneId: string): string | null
  agentLabel(agentKey: string): string
  slotLabel(agentKey: string, slotId: string): string
  /** Credentials moved. The app clears the exhausted flags it holds for the
   *  listed panes without resuming any loop, and offers its manual continue. */
  onSwitchCommitted(ev: CommitEvent): void
  onIncidentReady(incident: FailoverIncident): void
  onSwitchRefused(code: string, message: string, details: Record<string, unknown> | undefined): void
}

type Backend = ReturnType<typeof useBackend>

/** How often a busy pane is re-judged while a transaction waits for it. */
export const PREPARE_RECHECK_MS = 2000

/** Refusals that mean the button was made for a state that is gone — the
 *  row's buttons are withdrawn until the next notice re-offers them. */
export const STALE_SWITCH_CODES: ReadonlySet<string> = new Set([
  'STALE_EPOCH', 'STALE_STATE', 'STALE_INCIDENT', 'ALREADY_TRIED', 'CANDIDATE_EXCLUDED', 'TRANSACTION_ACTIVE',
])

interface Labels {
  agentLabel(agentKey: string): string
  slotLabel(agentKey: string, slotId: string): string
}

function distinct(values: string[]): number {
  return new Set(values).size
}

function latestTransaction(incident: FailoverIncident, transactions: FailoverTransaction[]): FailoverTransaction | null {
  const own = transactions.filter((t) => t.incidentId === incident.id)
  if (own.length === 0) return null
  own.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return own[0]
}

/** Pure: one incident (with its transactions and, when fetched, the backend's
 *  candidates) as the announcements feed shows it. Every button it yields
 *  carries the epoch the backend will check the click against — the
 *  post-commit epoch once credentials moved, the incident's before that. */
export function noticeFromIncident(
  incident: FailoverIncident,
  transactions: FailoverTransaction[],
  candidates: FailoverCandidate[] | null,
  labels: Labels,
): QuotaIncidentNotice {
  const tx = latestTransaction(incident, transactions)
  let status: QuotaIncidentStatus = incident.state
  if (tx?.state === 'awaiting-confirmation') status = 'awaiting-confirmation'
  else if (tx?.state === 'partial' && (incident.state === 'settling' || incident.state === 'notify-stopped')) status = 'partial'
  const committed = tx !== null && tx.swapped
  const epoch = committed && tx.epochAfter !== null ? tx.epochAfter : incident.epoch
  const offers: QuotaCandidateOffer[] = []
  const excluded: QuotaExcludedOffer[] = []
  if (candidates && incident.trusted && !tx?.swapped && (status === 'detected' || status === 'notify-stopped')) {
    for (const c of candidates) {
      const label = labels.slotLabel(incident.agentKey, c.slotId)
      if (c.excluded === null) {
        offers.push({
          slotId: c.slotId,
          label,
          tier: c.tier,
          detail: c.headroom === null ? undefined : `${Math.round(c.headroom)}%`,
        })
      } else if (c.excluded !== 'current') {
        excluded.push({ label, reason: c.excluded })
      }
    }
  }
  const resets = incident.resetsAt ? Date.parse(incident.resetsAt) : NaN
  return {
    incidentId: incident.id,
    agentKey: incident.agentKey,
    agentLabel: labels.agentLabel(incident.agentKey),
    authScope: incident.authScope,
    epoch,
    status,
    cause: 'quota-exhausted',
    reason: incident.reason ?? (tx?.reason ?? undefined) ?? undefined,
    untrusted: !incident.trusted,
    sourceLabel: labels.slotLabel(incident.agentKey, incident.outgoingSlotId),
    targetLabel: tx ? labels.slotLabel(incident.agentKey, tx.toSlotId) : undefined,
    affected: {
      workspaces: distinct(incident.panes.map((p) => p.workspacePath)),
      panes: incident.panes.length,
    },
    candidates: offers,
    excluded,
    resetExpectedAt: Number.isFinite(resets) ? resets : null,
    switchBack: committed ? { slotId: tx.fromSlotId, label: labels.slotLabel(incident.agentKey, tx.fromSlotId) } : undefined,
    retryResume: committed && tx.panes.some((p) => p.settle === 'failed'),
    notSwitchedPanes: tx?.overriddenPanes?.length || undefined,
    observedAt: Date.parse(incident.detectedAt),
    updatedAt: Math.max(Date.parse(incident.updatedAt), tx ? Date.parse(tx.closedAt ?? tx.committedAt ?? tx.createdAt) : 0),
  }
}

/** Pure: a `PaneReadiness` as the ack payload the backend expects. */
export function ackPayload(transactionId: string, paneId: string, readiness: PaneReadiness): Record<string, unknown> {
  if (readiness.ready) {
    return {
      transaction_id: transactionId,
      pane_id: paneId,
      ready: true,
      idle: 'turn-boundary',
      resume: { session_id: readiness.sessionId ?? '', resumable: readiness.resumable },
    }
  }
  return { transaction_id: transactionId, pane_id: paneId, ready: false, reason: readiness.reason }
}

const state = ref<FailoverState | null>(null) as Ref<FailoverState | null>
let backend: Backend | null = null
let hooks: QuotaFailoverHooks | null = null
const offs: (() => void)[] = []
/** Last-known incidents by id, kept after the backend stops listing them so a
 *  finished switch stays on screen with its result. */
const knownIncidents = new Map<string, FailoverIncident>()
const knownTransactions = new Map<string, FailoverTransaction>()
/** Candidates fetched per incident, keyed by the incident's updatedAt so a
 *  changed incident is re-fetched once. */
const candidateCache = new Map<string, { at: string; list: FailoverCandidate[] }>()
/** Transactions this window has already restarted panes for: (tx, pane). */
const restarted = new Set<string>()
// Keep completed work across a lost settle response. Reconnect retries proof,
// never the already completed rebuild.
const pendingRestarts = new Map<string, { ev: CommitEvent; pane: PrepareEventPane; result: RestartOutcome }>()
/** Gate installation is independent of restart delivery, and once per pane:
 *  replaying a commit must not re-block a pane whose recovery was verified. */
const commitNotified = new Set<string>()
/** Pane id after a restart → the transaction and the pane id it listed, so
 *  the turn-complete settle names the pane the backend knows. */
const restartedPanes = new Map<string, { txId: string; originalPaneId: string; termId: string | null }>()
/** Incidents the app was already told are ready (refreshNotices re-runs). */
const readyNotified = new Set<string>()
/** Prepares this window still owes a ready-ack for (busy panes). */
const pendingPrepares = new Map<string, { ev: PrepareEvent; panes: Set<string>; timer: ReturnType<typeof setTimeout> | null }>()

function announcements() {
  return useAnnouncements()
}

function allTransactions(): FailoverTransaction[] {
  return [...knownTransactions.values()]
}

function idempotencyKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function send<T>(type: string, payload: Record<string, unknown>): Promise<{ ok: true; payload: T } | { ok: false; code: string; message: string; details?: Record<string, unknown> }> {
  const b = backend
  if (!b || b.status.value !== 'connected') return { ok: false, code: 'DISCONNECTED', message: 'backend not connected' }
  try {
    const resp = await b.send<T>(type, payload)
    if (resp.ok && resp.payload) return { ok: true, payload: resp.payload as T }
    return { ok: false, code: resp.error?.code ?? 'ERROR', message: resp.error?.message ?? '', details: resp.error?.details }
  } catch (err) {
    return { ok: false, code: 'ERROR', message: String(err) }
  }
}

function applyState(next: FailoverState): void {
  state.value = next
  for (const inc of [...next.incidents, ...(next.recentIncidents ?? [])]) knownIncidents.set(inc.id, inc)
  for (const tx of [...next.transactions, ...(next.recentTransactions ?? [])]) knownTransactions.set(tx.id, tx)
  for (const tx of next.transactions) {
    if (tx.swapped && tx.closedAt === null && (tx.state === 'committed' || tx.state === 'partial')) {
      notifyCommit(commitEvent(tx, tx.panes))
      for (const p of tx.panes) {
        if (p.newPaneId && p.newTermId && hooks?.ownsPane(p.newPaneId) && hooks.paneTermId(p.newPaneId) === p.newTermId &&
          (!p.newSessionId || hooks.paneSessionId(p.newPaneId) === p.newSessionId)) {
          notifyCommit(commitEvent(tx, [{ ...p, paneId: p.newPaneId, termId: p.newTermId }]))
        }
      }
    }
  }
  // An incident the backend stopped listing without a terminal state (it
  // keeps only open ones) is closed as far as we can tell; keep what we
  // last saw rather than invent a result.
  for (const tx of knownTransactions.values()) {
    if (!next.transactions.some((t) => t.id === tx.id) && !(next.recentTransactions ?? []).some((t) => t.id === tx.id) && tx.closedAt === null && (tx.state === 'preparing' || tx.state === 'waiting-safe' || tx.state === 'awaiting-confirmation')) {
      knownTransactions.set(tx.id, { ...tx, state: 'cancelled', closedAt: new Date().toISOString() })
      dropPendingPrepare(tx.id)
    }
  }
  refreshNotices()
  void refreshCandidates()
}

function refreshNotices(): void {
  const h = hooks
  if (!h) return
  const a = announcements()
  const txs = allTransactions()
  const unreconciled = state.value?.unreconciled ?? {}
  for (const inc of knownIncidents.values()) {
    const cached = candidateCache.get(inc.id)
    const notice = noticeFromIncident(inc, txs, cached && cached.at === inc.updatedAt ? cached.list : null, h)
    if (unreconciled[inc.agentKey] && inc.closedAt === null) notice.blockedReason = 'unreconciled'
    a.noteQuotaIncident(notice)
    if (inc.state === 'ready' && !readyNotified.has(inc.id)) {
      readyNotified.add(inc.id)
      h.onIncidentReady(inc)
    }
  }
  for (const [agentKey, u] of Object.entries(unreconciled)) {
    a.noteQuotaIncident(reconcileNotice(u, h))
    void agentKey
  }
  for (const id of reconcileShown) {
    if (!unreconciled[id]) {
      a.dismissQuotaIncident(`reconcile:${id}`)
      reconcileShown.delete(id)
    }
  }
  for (const id of Object.keys(unreconciled)) reconcileShown.add(id)
}

/** Agents whose reconcile row is on screen, so it can be taken down once the
 *  backend no longer lists them. */
const reconcileShown = new Set<string>()

/** Pure: the row for an unreconciled switch. Its only buttons reconcile; the
 *  choice is spelled out per account when the backend cannot tell. */
export function reconcileNotice(u: FailoverUnreconciled, labels: Labels): QuotaIncidentNotice {
  const now = Date.now()
  const choices = u.liveSlotId !== null
    ? [{ slotId: null, label: labels.slotLabel(u.agentKey, u.liveSlotId) }]
    : [
        { slotId: u.fromSlotId, label: labels.slotLabel(u.agentKey, u.fromSlotId) },
        { slotId: u.toSlotId, label: labels.slotLabel(u.agentKey, u.toSlotId) },
      ]
  return {
    incidentId: `reconcile:${u.agentKey}`,
    agentKey: u.agentKey,
    agentLabel: labels.agentLabel(u.agentKey),
    authScope: u.authScope,
    epoch: 0,
    status: 'unreconciled',
    cause: 'quota-exhausted',
    reason: u.reason,
    sourceLabel: labels.slotLabel(u.agentKey, u.fromSlotId),
    targetLabel: labels.slotLabel(u.agentKey, u.toSlotId),
    affected: { workspaces: 0, panes: 0 },
    reconcile: { transactionId: u.transactionId, choices },
    observedAt: now,
    // Stable: the row is re-noted on every state, and must not flip unread
    // each time. The backend has no timestamp for it.
    updatedAt: 0,
  }
}

async function refreshCandidates(): Promise<void> {
  const h = hooks
  if (!h) return
  for (const inc of knownIncidents.values()) {
    if (inc.closedAt !== null || !inc.trusted) continue
    if (inc.state !== 'detected' && inc.state !== 'notify-stopped') continue
    const cached = candidateCache.get(inc.id)
    if (cached && cached.at === inc.updatedAt) continue
    const res = await send<{ candidates: FailoverCandidate[] }>('quota_failover.candidates', { agent_key: inc.agentKey })
    if (!res.ok) continue
    candidateCache.set(inc.id, { at: inc.updatedAt, list: res.payload.candidates ?? [] })
    const latest = knownIncidents.get(inc.id)
    if (latest) announcements().noteQuotaIncident(noticeFromIncident(latest, allTransactions(), res.payload.candidates ?? [], h))
  }
}

async function loadState(): Promise<void> {
  const res = await send<FailoverState>('quota_failover.get_state', {})
  if (res.ok) {
    applyState(res.payload)
    await reconcile()
  }
}

/** After reconnect, replay local results or restore backend-validated pane
 *  associations. A changed PTY alone is not proof of our restart. */
async function reconcile(): Promise<void> {
  const h = hooks
  const s = state.value
  if (!h || !s) return
  for (const tx of s.transactions) {
    if (tx.epochAfter !== null && (s.epochs[tx.agentKey] ?? tx.epochAfter) > tx.epochAfter) continue
    const mine = tx.panes.filter((p) => h.ownsPane(p.paneId))
    if (tx.state === 'preparing' || tx.state === 'waiting-safe') {
      const ev: PrepareEvent = {
        transactionId: tx.id, incidentId: tx.incidentId, agentKey: tx.agentKey, authScope: tx.authScope,
        fromSlotId: tx.fromSlotId, toSlotId: tx.toSlotId, restartStrategy: tx.restartStrategy,
        automatic: tx.automatic, deadlineAt: '', panes: mine.filter((p) => p.ack !== 'ready'),
      }
      if (ev.panes.length > 0) await onPrepare(ev)
    } else if (tx.swapped && tx.closedAt === null && (tx.state === 'committed' || tx.state === 'partial')) {
      for (const p of tx.panes) {
        const key = `${tx.id}:${p.paneId}`
        if (pendingRestarts.has(key)) {
          await settleRestart(key)
        } else if (p.newPaneId && p.newTermId && h.ownsPane(p.newPaneId) && h.paneTermId(p.newPaneId) === p.newTermId &&
          (!p.newSessionId || h.paneSessionId(p.newPaneId) === p.newSessionId)) {
          restarted.add(key)
          restartedPanes.set(p.newPaneId, { txId: tx.id, originalPaneId: p.paneId, termId: p.newTermId })
          notifyCommit(commitEvent(tx, [{ ...p, paneId: p.newPaneId, termId: p.newTermId }]))
          // The server may have recorded the create before the renderer lost
          // its settle result. Lineage permits submitting proof, not claiming
          // readiness: only an accepted settle validates the session.
          if (tx.state === 'committed' && p.settle === null) {
            const result: RestartOutcome = tx.restartStrategy === 'new-conversation'
              ? { outcome: 'new-conversation', paneId: p.newPaneId, termId: p.newTermId }
              : { outcome: 'resumed', paneId: p.newPaneId, termId: p.newTermId, sessionId: p.sessionId ?? h.paneSessionId(p.newPaneId) }
            pendingRestarts.set(key, { ev: commitEvent(tx, [p]), pane: p, result })
            await settleRestart(key)
          }
        } else if (tx.state === 'committed' && p.settle === null && tx.switchMode !== 'hot' && h.ownsPane(p.paneId) && h.paneTermId(p.paneId) === p.termId && !restarted.has(key)) {
          await onCommit(commitEvent(tx, [p]))
        }
      }
    }
  }
}

async function settleRestart(key: string): Promise<boolean> {
  const pending = pendingRestarts.get(key)
  if (!pending) return true
  const { ev, pane, result } = pending
  const tx = knownTransactions.get(ev.transactionId)
  const epoch = state.value?.epochs[ev.agentKey]
  if (tx?.closedAt || (epoch !== undefined && ev.epoch !== null && epoch > ev.epoch)) return false
  const res = await send('quota_failover.settle', {
    transaction_id: ev.transactionId, pane_id: pane.paneId, outcome: result.outcome,
    ...(result.outcome === 'failed' ? { reason: result.reason } : {
      new_pane_id: result.paneId, term_id: result.termId ?? '',
      session_id: result.outcome === 'resumed' ? (result.sessionId ?? '') : '',
    }),
  })
  if (res.ok && pendingRestarts.get(key) === pending) pendingRestarts.delete(key)
  return res.ok
}

function commitEvent(tx: FailoverTransaction, panes: PrepareEventPane[]): CommitEvent {
  return {
    transactionId: tx.id, incidentId: tx.incidentId, agentKey: tx.agentKey, authScope: tx.authScope,
    fromSlotId: tx.fromSlotId, toSlotId: tx.toSlotId, epoch: tx.epochAfter, switchMode: tx.switchMode,
    restartStrategy: tx.restartStrategy, state: tx.state === 'partial' ? 'partial' : 'committed',
    needsLogin: false, needsLoginReason: null, panes,
    hotSwitchedPanes: tx.hotSwitchedPanes,
  }
}

function notifyCommit(ev: CommitEvent): void {
  const h = hooks
  if (!h) return
  if (readyNotified.has(ev.incidentId)) return
  if (knownTransactions.get(ev.transactionId)?.closedAt || (ev.epoch !== null && (state.value?.epochs[ev.agentKey] ?? ev.epoch) > ev.epoch)) return
  const panes = ev.panes.filter((p) => h.ownsPane(p.paneId) && !commitNotified.has(`${ev.transactionId}:${p.paneId}`))
  if (panes.length === 0) return
  for (const p of panes) commitNotified.add(`${ev.transactionId}:${p.paneId}`)
  h.onSwitchCommitted({ ...ev, panes })
}

function dropPendingPrepare(txId: string): void {
  const pending = pendingPrepares.get(txId)
  if (!pending) return
  if (pending.timer) clearTimeout(pending.timer)
  pendingPrepares.delete(txId)
}

async function ackPane(ev: PrepareEvent, paneId: string): Promise<'ready' | 'busy' | 'refused'> {
  const h = hooks
  if (!h) return 'refused'
  const readiness = h.ownsPane(paneId)
    ? await h.paneReadiness(paneId, { needsResume: ev.restartStrategy === 'resume' })
    : ({ ready: false, reason: 'refused' } as const)
  const res = await send<{ transaction: FailoverTransaction }>('quota_failover.ack', ackPayload(ev.transactionId, paneId, readiness))
  if (res.ok) knownTransactions.set(res.payload.transaction.id, res.payload.transaction)
  if (!readiness.ready) return readiness.reason === 'busy' ? 'busy' : 'refused'
  return 'ready'
}

async function onPrepare(ev: PrepareEvent): Promise<void> {
  const h = hooks
  if (!h) return
  dropPendingPrepare(ev.transactionId)
  const busy = new Set<string>()
  for (const pane of ev.panes) {
    if (!h.ownsPane(pane.paneId)) continue
    const answer = await ackPane(ev, pane.paneId)
    if (answer === 'busy') busy.add(pane.paneId)
    if (answer === 'refused') return
  }
  if (busy.size > 0) schedulePrepareRecheck(ev, busy)
}

function schedulePrepareRecheck(ev: PrepareEvent, panes: Set<string>): void {
  const entry = { ev, panes, timer: null as ReturnType<typeof setTimeout> | null }
  pendingPrepares.set(ev.transactionId, entry)
  entry.timer = setTimeout(() => void recheckPrepare(ev.transactionId), PREPARE_RECHECK_MS)
}

async function recheckPrepare(txId: string): Promise<void> {
  const entry = pendingPrepares.get(txId)
  if (!entry) return
  entry.timer = null
  const tx = knownTransactions.get(txId)
  if (tx && tx.state !== 'preparing' && tx.state !== 'waiting-safe') {
    pendingPrepares.delete(txId)
    return
  }
  for (const paneId of [...entry.panes]) {
    const answer = await ackPane(entry.ev, paneId)
    if (answer !== 'busy') entry.panes.delete(paneId)
    if (answer === 'refused') {
      pendingPrepares.delete(txId)
      return
    }
  }
  if (entry.panes.size === 0) {
    pendingPrepares.delete(txId)
    return
  }
  entry.timer = setTimeout(() => void recheckPrepare(txId), PREPARE_RECHECK_MS)
}

function retryPane(pane: PrepareEventPane, txId: string): PrepareEventPane | null {
  const h = hooks
  if (!h) return null
  const proof = knownTransactions.get(txId)?.panes.find((p) => p.paneId === pane.paneId)
  const local = [...restartedPanes].find(([id, p]) => p.txId === txId && p.originalPaneId === pane.paneId &&
    h.ownsPane(id) && p.termId !== null && h.paneTermId(id) === p.termId)
  const id = local?.[0] ?? proof?.newPaneId
  const termId = local?.[1].termId ?? proof?.newTermId
  if (id && termId && h.ownsPane(id) && h.paneTermId(id) === termId) {
    return { ...pane, paneId: id, termId, originalPaneId: pane.paneId }
  }
  return h.ownsPane(pane.paneId) && h.paneTermId(pane.paneId) === pane.termId ? pane : null
}

async function onCommit(ev: CommitEvent, opts: { notifyApp: boolean; retry?: boolean } = { notifyApp: true }): Promise<void> {
  const h = hooks
  if (!h) return
  if (knownTransactions.get(ev.transactionId)?.closedAt || (ev.epoch !== null && (state.value?.epochs[ev.agentKey] ?? ev.epoch) > ev.epoch)) return
  dropPendingPrepare(ev.transactionId)
  if (opts.notifyApp) notifyCommit(ev)
  if (ev.switchMode === 'hot' || ev.restartStrategy === 'none') return
  if (!opts.retry && (ev.state === 'partial' || knownTransactions.get(ev.transactionId)?.state === 'partial')) return
  const overridden = new Set(knownTransactions.get(ev.transactionId)?.overriddenPanes ?? [])
  for (const pane of ev.panes) {
    const target = opts.retry ? retryPane(pane, ev.transactionId)
      : h.ownsPane(pane.paneId) && h.paneTermId(pane.paneId) === pane.termId ? pane : null
    if (!target || overridden.has(pane.paneId)) continue
    const key = `${ev.transactionId}:${pane.paneId}`
    if (restarted.has(key)) continue
    restarted.add(key)
    let result: RestartOutcome
    try {
      result = ev.restartStrategy === 'new-conversation'
        ? await h.openNewConversation(target, ev)
        : await h.restartPane(target, ev)
    } catch {
      result = { outcome: 'failed', reason: 'restart-failed' }
    }
    pendingRestarts.set(key, { ev, pane, result })
    if (result.outcome !== 'failed') {
      restartedPanes.set(result.paneId, { txId: ev.transactionId, originalPaneId: pane.paneId, termId: result.termId })
      notifyCommit({ ...ev, panes: [{ ...pane, paneId: result.paneId, termId: result.termId ?? '' }] })
    }
    await settleRestart(key)
  }
}

/** A pane finished a turn. If it is part of a committed, unsettled
 *  transaction (or is the pane a restart produced), that turn is the evidence
 *  the backend waits for — with the turn's own start time, so a turn that
 *  began under the old account cannot pass. */
async function noteTurnComplete(paneId: string, termId: string | null, turnStartedAt: number | null): Promise<void> {
  const restart = restartedPanes.get(paneId)
  if (restart && restart.termId !== termId) return
  const candidates = restart
    ? [{ txId: restart.txId, originalPaneId: restart.originalPaneId }]
    : allTransactions()
        .filter((t) => (t.state === 'committed' || t.state === 'partial') && t.closedAt === null && t.panes.some((p) => p.paneId === paneId))
        .map((t) => ({ txId: t.id, originalPaneId: paneId }))
  for (const c of candidates) {
    const tx = knownTransactions.get(c.txId)
    if (!tx || tx.closedAt !== null) continue
    if (pendingRestarts.has(`${c.txId}:${c.originalPaneId}`) && !await settleRestart(`${c.txId}:${c.originalPaneId}`)) continue
    void send('quota_failover.settle', {
      transaction_id: c.txId,
      pane_id: c.originalPaneId,
      outcome: 'turn-complete',
      term_id: termId ?? '',
      turn_started_at: turnStartedAt ? new Date(turnStartedAt).toISOString() : '',
    })
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ExhaustionReport {
  agentKey: string
  paneId: string
  workspacePath: string
  at: number
  resetsAt: number | null
  windowKind: string | null
  source: 'cli-text' | 'usage-window'
  text?: string
  idempotencyKey: string
}

/** Tell the backend a pane ran out. Returns the incident it was filed under,
 *  or null when the backend refused (an unknown vendor, a signal that is not
 *  exhaustion) or is not there. */
async function report(r: ExhaustionReport): Promise<{ incident: FailoverIncident; created: boolean } | null> {
  const res = await send<{ incident: FailoverIncident; created: boolean }>('quota_failover.report', {
    agent_key: r.agentKey,
    pane_id: r.paneId,
    workspace_path: r.workspacePath,
    at: new Date(r.at).toISOString(),
    resets_at: r.resetsAt === null ? null : new Date(r.resetsAt).toISOString(),
    window_kind: r.windowKind,
    signal: 'quota-exhausted',
    source: r.source,
    text: r.text ?? '',
    idempotency_key: r.idempotencyKey,
  })
  if (!res.ok) return null
  knownIncidents.set(res.payload.incident.id, res.payload.incident)
  refreshNotices()
  return res.payload
}

async function setPolicy(mode: FailoverMode): Promise<boolean> {
  const res = await send<FailoverState>('quota_failover.set_policy', { mode })
  if (!res.ok) return false
  applyState(res.payload)
  return true
}

/** Propose a switch from an announcement button. The backend re-checks the
 *  slot, the epoch and the incident; a refusal withdraws the row's buttons
 *  when it says the state moved on. */
async function actOn(action: QuotaAnnouncementAction): Promise<void> {
  const h = hooks
  if (!h) return
  if (action.kind === 'quota-reconcile') {
    const payload: Record<string, unknown> = { agent_key: action.agentKey, transaction_id: action.transactionId }
    if (action.liveSlotId !== null) payload.live_slot_id = action.liveSlotId
    const res = await send<{ agentKey: string; liveSlotId: string; transactionId: string }>('quota_failover.reconcile', payload)
    if (!res.ok) {
      const identity = res.details?.liveIdentity as { email?: string | null } | undefined
      h.onSwitchRefused(res.code, identity?.email ? `${res.message} (${identity.email})` : res.message, res.details)
      return
    }
    await loadState()
    return
  }
  if (action.kind === 'quota-retry-resume') {
    // Only a transaction the backend still lists as unsettled, under the
    // epoch the button was made for. A manual switch since then bumped the
    // epoch (and closed the transaction), so an old button restarts nothing.
    const tx = allTransactions().find(
      (t) => t.incidentId === action.incidentId && (t.state === 'partial' || t.state === 'committed') && t.closedAt === null,
    )
    const currentEpoch = state.value?.epochs[action.agentKey]
    if (!tx || tx.epochAfter !== action.epoch || (currentEpoch !== undefined && currentEpoch !== action.epoch)) {
      announcements().invalidateQuotaActions(action.incidentId)
      h.onSwitchRefused('STALE_EPOCH', 'the account changed since this was offered', { epoch: currentEpoch })
      return
    }
    for (const p of tx.panes) {
      if (p.settle !== 'failed' || !retryPane(p, tx.id)) continue
      restarted.delete(`${tx.id}:${p.paneId}`)
      pendingRestarts.delete(`${tx.id}:${p.paneId}`)
    }
    await onCommit({
      transactionId: tx.id, incidentId: tx.incidentId, agentKey: tx.agentKey, authScope: tx.authScope,
      fromSlotId: tx.fromSlotId, toSlotId: tx.toSlotId, epoch: tx.epochAfter, switchMode: tx.switchMode,
      restartStrategy: tx.restartStrategy, state: tx.state === 'partial' ? 'partial' : 'committed',
      needsLogin: false, needsLoginReason: null, panes: tx.panes.filter((p) => p.settle === 'failed'),
    }, { notifyApp: false, retry: true })
    return
  }
  const incident = knownIncidents.get(action.incidentId)
  const tx = incident ? latestTransaction(incident, allTransactions()) : null
  const expectedCurrent = action.kind === 'quota-switch-back' && tx ? tx.toSlotId : (incident?.outgoingSlotId ?? '__default__')
  const switchPayload = {
    agent_key: action.agentKey,
    to_slot_id: action.slotId,
    incident_id: action.incidentId,
    expected_current_slot_id: expectedCurrent,
    expected_epoch: action.epoch,
    automatic: false,
  }
  let res = await send<{ transaction: FailoverTransaction }>('quota_failover.switch', { ...switchPayload, idempotency_key: idempotencyKey() })
  if (
    res.ok &&
    res.payload.transaction?.state === 'cancelled' &&
    res.payload.transaction.reason === 'live-drift-unverified' &&
    typeof res.payload.transaction.liveFingerprint === 'string' &&
    res.payload.transaction.liveFingerprint
  ) {
    // The backend answered with a cancelled transaction, not an error: the
    // live credential changed and the vendor stores no identity to tell a
    // token refresh from another sign-in. Only the user can say, so ask —
    // and on yes resend the SAME switch (target, incident, expected slot and
    // epoch unchanged; the backend re-checks those and still refuses a
    // stale state) with the assumption, under a FRESH request id: the same
    // idempotency key would just hand back the cancelled transaction. A
    // verified drift ("live-drift") and every automatic switch never take
    // this path; a decline resends nothing.
    const fingerprint = res.payload.transaction.liveFingerprint
    knownTransactions.set(res.payload.transaction.id, res.payload.transaction)
    refreshNotices()
    const ok = await h.confirmLiveIsCurrent(action.agentKey, expectedCurrent, action.slotId)
    if (!ok) return
    // The fingerprint goes back exactly as the cancelled transaction reported
    // it (never re-read after the dialog) and must still match, so a live
    // credential the CLI rewrote during the dialog is refused even with the
    // epoch unchanged. A cancelled transaction without one is no proof at
    // all: the guard above leaves it unresent.
    res = await send<{ transaction: FailoverTransaction }>('quota_failover.switch', {
      ...switchPayload, idempotency_key: idempotencyKey(), assume_live_is_current: true, live_fingerprint: fingerprint,
    })
  }
  if (!res.ok) {
    if (STALE_SWITCH_CODES.has(res.code)) {
      announcements().invalidateQuotaActions(action.incidentId)
    }
    h.onSwitchRefused(res.code, res.message, res.details)
    return
  }
  const transaction = res.payload.transaction
  if (!transaction) return
  knownTransactions.set(transaction.id, transaction)
  refreshNotices()
  if (transaction.state === 'awaiting-confirmation') {
    const ok = await h.confirmNewConversation(transaction)
    const verb = ok ? 'quota_failover.confirm' : 'quota_failover.cancel'
    const answer = await send<{ transaction: FailoverTransaction }>(verb, { transaction_id: transaction.id })
    if (answer.ok) {
      knownTransactions.set(answer.payload.transaction.id, answer.payload.transaction)
      refreshNotices()
    } else {
      // The user answered and the backend would not take the answer — either
      // way they hear it; an accepted confirmation that silently went nowhere
      // would leave them waiting for a switch that is not coming.
      h.onSwitchRefused(answer.code, answer.message, answer.details)
    }
  }
}

async function cancel(transactionId: string): Promise<void> {
  const res = await send<{ transaction: FailoverTransaction }>('quota_failover.cancel', { transaction_id: transactionId })
  if (res.ok) {
    knownTransactions.set(res.payload.transaction.id, res.payload.transaction)
    refreshNotices()
  }
}

function capabilityFor(agentKey: string): FailoverCapability | undefined {
  return state.value?.capabilities[agentKey]
}

/** The automatic-switch budget of this agent's own credential pool. */
function budgetFor(agentKey: string): FailoverBudget | undefined {
  const scope = state.value?.capabilities[agentKey]?.authScope
  const rows = Object.values(state.value?.budget ?? {}).filter((b) => b.agentKey === agentKey)
  return rows.find((b) => b.authScope === scope) ?? rows[0]
}

/** Who an automatic switch would pick next, for the quota popover. Read on
 *  demand only — the backend checks each slot's login state to rank them —
 *  and kept for a minute so reopening the popover does not read again. */
const PREVIEW_TTL_MS = 60_000
const previewCache = new Map<string, { at: number; list: FailoverCandidate[] }>()
async function previewCandidates(agentKey: string): Promise<FailoverCandidate[] | null> {
  const hit = previewCache.get(agentKey)
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.list
  const res = await send<{ candidates: FailoverCandidate[] }>('quota_failover.candidates', { agent_key: agentKey })
  if (!res.ok) return null
  const list = res.payload?.candidates ?? []
  previewCache.set(agentKey, { at: Date.now(), list })
  return list
}

/** True while a failover transaction for this agent is open or has moved
 *  credentials but not settled — the window in which a `cli_profiles.changed`
 *  for the agent is the transaction's own, not a manual switch. */
function agentHasActiveTransaction(agentKey: string): boolean {
  return allTransactions().some(
    (t) => t.agentKey === agentKey && t.closedAt === null && t.state !== 'cancelled' && t.state !== 'failed',
  )
}

function initQuotaFailover(b: Backend, h: QuotaFailoverHooks): void {
  if (backend) return
  backend = b
  hooks = h
  offs.push(b.on('quota_failover.changed', (raw) => applyState(raw as FailoverState)))
  offs.push(b.on('quota_failover.prepare', (raw) => void onPrepare(raw as PrepareEvent)))
  offs.push(b.on('quota_failover.commit', (raw) => void onCommit(raw as CommitEvent)))
  offs.push(b.on('session.detected', (raw) => {
    const paneId = (raw as { pane_id?: string }).pane_id
    for (const [key, pending] of pendingRestarts) {
      if (pending.result.outcome !== 'failed' && pending.result.paneId === paneId) void settleRestart(key)
    }
  }))
  // State can arrive before restore realizes the owned panes. Reconcile when
  // their ownership/binding becomes available as well as on socket reconnect.
  offs.push(watch(
    [() => state.value, () => state.value?.transactions.flatMap((tx) => tx.panes.flatMap((p) => [p.paneId, p.newPaneId]
      .filter((id): id is string => !!id)
      .map((id) => `${id}:${h.ownsPane(id)}:${h.paneTermId(id)}:${h.paneSessionId(id)}`))).join('|')],
    ([current], [previous]) => {
      // New server state is handled by loadState/commit; this watcher only
      // handles local pane realization or a later session binding.
      if (!current || current !== previous) return
      applyState(current)
      void reconcile()
    },
  ))
  offs.push(
    watch(
      () => b.status.value,
      (s) => {
        if (s === 'connected') void loadState()
      },
      { immediate: true },
    ),
  )
}

/** Test-only: detach and clear the singleton. */
function __resetQuotaFailoverForTest(): void {
  for (const off of offs.splice(0)) off()
  backend = null
  hooks = null
  state.value = null
  knownIncidents.clear()
  knownTransactions.clear()
  candidateCache.clear()
  previewCache.clear()
  restarted.clear()
  pendingRestarts.clear()
  commitNotified.clear()
  restartedPanes.clear()
  readyNotified.clear()
  for (const id of [...pendingPrepares.keys()]) dropPendingPrepare(id)
}

export function useQuotaFailover() {
  return {
    state,
    initQuotaFailover,
    report,
    setPolicy,
    actOn,
    cancel,
    noteTurnComplete,
    capabilityFor,
    budgetFor,
    previewCandidates,
    agentHasActiveTransaction,
    __resetQuotaFailoverForTest,
  }
}
