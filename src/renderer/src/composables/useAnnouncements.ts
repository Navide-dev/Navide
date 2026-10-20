import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { WHATS_NEW, cmpSemver, pickText } from '../lib/whatsNew'
import type { CandidateTier, ExclusionReason, FailureCause } from '../lib/quotaFailover'
import type { UpdateState } from '../../../shared/updater'
import type { EvolveRun } from './useEvolve'
import type { ConvenienceSnapshot } from './useConvenience'
import { convenienceText } from '../lib/convenienceText'

/**
 * Announcements centre — the status-bar feed of version news.
 *
 * Four sources, normalised into one list: the curated release notes in
 * whatsNew.ts (everything up to the running version), the live updater state (a
 * pending update, or a run of failed background checks), what the backend
 * reports about its own start, and quota-exhaustion incidents (an account ran
 * out; here is what happened next and what the user can do). Read state is a
 * bounded id set in ui_settings, so it follows the user across windows —
 * except for quota incidents, which are live state the backend re-publishes,
 * so their read marks stay in this window.
 *
 * Module-level singleton state, like useNotify — the status-bar item and the
 * popover read the same feed without prop drilling.
 */

export type AnnouncementKind =
  | 'release' | 'update' | 'quota' | 'scheduler' | 'evolve' | 'share' | 'convenience' | 'plugin-agent' | 'plugin-staged' | 'plugin-switch'
/** The button an update row offers, when its status affords one. */
export type AnnouncementAction = 'download' | 'install'

/** A button on a quota incident. Every one names the incident, the account
 *  and the credential epoch it was offered under, so the backend can refuse a
 *  click that outlived the state it was made for. There is deliberately no
 *  general "run this command" shape — a row can only ask for one of these. */
export type QuotaAnnouncementAction =
  | { kind: 'quota-switch'; incidentId: string; agentKey: string; slotId: string; epoch: number; label: string; tier: CandidateTier }
  | { kind: 'quota-retry-resume'; incidentId: string; agentKey: string; epoch: number }
  | { kind: 'quota-switch-back'; incidentId: string; agentKey: string; slotId: string; epoch: number; label: string }
  /** Complete a switch whose bookkeeping did not: tell the backend which
   *  account is really live (`liveSlotId` null = the backend already knows). */
  | { kind: 'quota-reconcile'; incidentId: string; agentKey: string; transactionId: string; liveSlotId: string | null; label: string }

/** A release row's "Take the tour": that version's WhatsNewEntry.tour. */
export type ReleaseTourAction = { kind: 'tour'; version: string }

/** A workspace self-evolution row's button. Each names the workspace and,
 *  for the pane buttons, the run's pane; App.vue maps them onto the existing
 *  pane actions (focus / interrupt / reclaim) or opens the evolve panel. */
export type EvolveAnnouncementAction = {
  kind: 'evolve-open-pane' | 'evolve-resume-pane' | 'evolve-interrupt' | 'evolve-reclaim' | 'evolve-panel' | 'evolve-result'
  workspace: string
  paneId?: string
}

/** A convenience-feature row's button (docs/en-US/convenience-features.md).
 *  App.vue maps them onto the overview, `convenience.*` RPCs and, for the
 *  account prompt, the existing cli_profiles default-account switch. */
export type ConvenienceAnnouncementAction =
  | { kind: 'convenience-overview' }
  | { kind: 'convenience-reallow'; featureId: string }
  | { kind: 'convenience-keep-login'; rowId: string }
  /** Acknowledges a notice that offers nothing else (an outside sign-out). */
  | { kind: 'convenience-dismiss'; rowId: string }
  /** Back to the account Navide would restore, named by the prompt's slotId. */
  | { kind: 'convenience-switch-back'; rowId: string; agentKey: string; slotId: string; label: string; liveFingerprint: string }
  | { kind: 'convenience-upgrade-ack' }

/** The undo on a "an agent disabled / enabled a Navide plugin" row (B2-c):
 *  the user's own Extensions switch, set back. On "an agent updated a Navide
 *  plugin" (O1): back to the version it was updated from. */
export type PluginAgentAnnouncementAction =
  | { kind: 'plugin-agent-undo'; pluginId: string; disable: boolean }
  | { kind: 'plugin-agent-downgrade'; pluginId: string; fromVersion: string; toVersion: string }
  /** A package staged beside the active one: apply it, as Restart does. */
  | { kind: 'plugin-staged-apply'; pluginId: string; activeVersion: string; stagedVersion: string }
  /** L3: back to the version an approved update switched away from. */
  | { kind: 'plugin-switch-back'; pluginId: string; fromVersion: string; toVersion: string }

export type AnnouncementActionSpec =
  | { kind: AnnouncementAction }
  | QuotaAnnouncementAction
  | ReleaseTourAction
  | EvolveAnnouncementAction
  | ConvenienceAnnouncementAction
  | PluginAgentAnnouncementAction

export interface Announcement {
  /** Stable across renders: `release:<version>`, `update:<version>`,
   *  `update-failed`, `quota:<incidentId>`. */
  id: string
  kind: AnnouncementKind
  version?: string
  /** Already localized for the active locale. */
  title: string
  highlights: string[]
  note?: string
  /** Only set where a real timestamp exists — never fabricated. */
  createdAt?: number
  read: boolean
  /** The single update button (kept for the updater rows and their handler). */
  action?: AnnouncementAction
  /** Typed buttons, in display order. Update rows carry their `action` here
   *  too; quota rows carry only these. */
  actions?: AnnouncementActionSpec[]
  /** Quota rows: the incident behind the row, for the popover's detail. */
  quota?: QuotaIncidentNotice
}

// ── Quota incidents ─────────────────────────────────────────────────────────

/** Where an incident is: the backend's Incident.state (quota_failover
 *  contract), plus two transaction states the row has to show on its own —
 *  `awaiting-confirmation` (a manual switch onto a CLI that cannot resume,
 *  waiting for the user to accept a new conversation) and `partial`
 *  (committed, at least one pane did not resume). The renderer only labels
 *  these; it never advances them. */
export type QuotaIncidentStatus =
  | 'detected'
  | 'awaiting-confirmation'
  | 'waiting-safe'
  | 'switching'
  | 'settling'
  | 'ready'
  | 'partial'
  | 'notify-stopped'
  /** Not an incident state: a switch whose bookkeeping needs the user. */
  | 'unreconciled'

/** Incident.reason from the backend, shown on `notify-stopped` and `ready`
 *  rows. The known values get a sentence; anything else is shown verbatim
 *  rather than hidden — the backend's word is the record. */
export type QuotaIncidentReason = string

export interface QuotaCandidateOffer {
  slotId: string
  /** Display name of the account (email or slot name), already resolved. */
  label: string
  tier: CandidateTier
  /** Already localized reading summary ("5h 78% left · 4 min ago"), if any. */
  detail?: string
}

/** Why the backend left a slot out: its Candidate.excluded value, or the
 *  finer-grained reasons of the pure ranker. */
export type QuotaExcludedReason = ExclusionReason | 'exhausted'

export interface QuotaExcludedOffer {
  label: string
  reason: QuotaExcludedReason
}

/** One quota incident as the feed shows it. The caller (App.vue, from the
 *  backend's `quota_failover` events) hands in a full notice on every change;
 *  the same `incidentId` updates the same row. */
export interface QuotaIncidentNotice {
  incidentId: string
  agentKey: string
  /** Vendor display name ("Claude Code"). */
  agentLabel: string
  authScope: string
  /** Credential epoch the notice — and every button on it — belongs to. */
  epoch: number
  status: QuotaIncidentStatus
  cause: FailureCause
  /** Incident.reason — why it stopped, or what made it ready. */
  reason?: QuotaIncidentReason
  /** Incident.trusted === false: the backend could not attribute or verify
   *  the signal, so the row only informs and offers nothing. */
  untrusted?: boolean
  /** The exhausted account, already labelled. */
  sourceLabel: string
  /** The account switched (or being switched) to, once one is chosen. */
  targetLabel?: string
  affected: { workspaces: number; panes: number }
  candidates?: QuotaCandidateOffer[]
  excluded?: QuotaExcludedOffer[]
  /** When the exhausted window is expected back — an estimate, never a
   *  verified recovery. */
  resetExpectedAt?: number | null
  /** Offered after a switch: the original account, for a manual switch back. */
  switchBack?: { slotId: string; label: string }
  /** Offered after a partial resume: retry attaching the panes that failed. */
  retryResume?: boolean
  /** Panes the swap could not reach (their credential comes from the
   *  environment); shown as not switched. */
  notSwitchedPanes?: number
  /** Set while the backend refuses every switch for this vendor (a previous
   *  switch is unreconciled): the row shows why and offers no switch. */
  blockedReason?: string
  /** Reconciliation offers, when this row is the unreconciled switch itself:
   *  one entry with liveSlotId null when the backend knows the live account,
   *  else one per account the user has to choose between. */
  reconcile?: { transactionId: string; choices: { slotId: string | null; label: string }[] }
  observedAt: number
  updatedAt: number
}

const READ_IDS_KEY = 'agentTeam.announcements.readIds'
/** Keep the persisted set small: ui_settings is one shared 512 KB document. */
const MAX_READ_IDS = 100

const readIds = ref<string[]>([])
/** The live updater state, handed in by App.vue — useUpdater is NOT a singleton
 *  and instantiating it here would add another onStateChanged subscription.
 *  Boxed in an object so the ref isn't unwrapped away by shallowRef's typing. */
const updateSource = shallowRef<{ state: Ref<UpdateState> } | null>(null)
let loaded = false

/** The feed id of a release announcement, so callers elsewhere (the What's New
 *  modal) can mark the same entry read without knowing the id format. */
export function releaseAnnouncementId(version: string): string {
  return `release:${version}`
}

const appVersion = computed(
  () => updateSource.value?.state.value.currentVersion || window.agentTeam?.version || ''
)

function releaseItems(locale: string, current: string): Announcement[] {
  if (!current) return []
  return WHATS_NEW.filter((entry) => cmpSemver(entry.version, current) <= 0)
    .slice()
    .sort((a, b) => cmpSemver(b.version, a.version))
    .map((entry) => ({
      id: releaseAnnouncementId(entry.version),
      kind: 'release' as const,
      version: entry.version,
      title: pickText(entry.title, locale),
      highlights: entry.highlights.map((text) => pickText(text, locale)),
      note: entry.note ? pickText(entry.note, locale) : undefined,
      read: false,
      actions: entry.tour?.length ? [{ kind: 'tour' as const, version: entry.version }] : undefined,
    }))
}

function updateItems(state: UpdateState | null): Announcement[] {
  if (!state) return []
  const t = i18n.global.t
  const items: Announcement[] = []

  // A run of failed background checks rides alongside the status, so it is its
  // own item rather than a variant of the pending-update one.
  const failure = state.lastCheckFailure
  if (failure) {
    const at = Date.parse(failure.at)
    items.push({
      id: 'update-failed',
      kind: 'update',
      title: t('updater.badge-check-failed'),
      highlights: [t('updater.check-failure', { count: failure.count, message: failure.message })],
      createdAt: Number.isNaN(at) ? undefined : at,
      read: false,
    })
  }

  const version = state.availableVersion ?? ''
  let title = ''
  let action: AnnouncementAction | undefined
  switch (state.status) {
    case 'available':
      title = t('updater.available', { version })
      action = 'download'
      break
    case 'downloading':
      title = t('updater.downloading', { percent: state.percent ?? 0 })
      break
    case 'downloaded':
      title = t('updater.downloaded')
      action = 'install'
      break
    case 'installing':
      title = t('updater.restarting')
      break
    case 'error':
      title = t('updater.error', { message: state.message ?? '' })
      break
    default:
      break
  }
  if (title) {
    const checkedAt = state.checkedAt ? Date.parse(state.checkedAt) : NaN
    items.push({
      id: version ? `update:${version}` : 'update-error',
      kind: 'update',
      version: version || undefined,
      title,
      highlights: state.releaseNotes ? [state.releaseNotes] : [],
      note: state.quitInstallArmed ? t('updater.downloaded-on-quit') : undefined,
      createdAt: Number.isNaN(checkedAt) ? undefined : checkedAt,
      read: false,
      action,
      actions: action ? [{ kind: action }] : undefined,
    })
  }
  return items
}

/** The version this backend replaced, when it started at a different one than
 *  the previous run. Reported by the backend on connect; null the rest of the
 *  time, which is every ordinary start. */
const backendUpgrade = ref<{ from: string; to: string } | null>(null)

/**
 * An MCP client reads a server's tool list once, when it connects. So a CLI or
 * an external client that was talking to the previous backend keeps the tools
 * it saw then, and nothing about the upgrade tells it otherwise.
 *
 * Its own item rather than a line in the release note: the release note says
 * what changed, this says what the reader has to do about it, and it is only
 * ever true right after an upgrade.
 */
function backendItems(): Announcement[] {
  const upgrade = backendUpgrade.value
  if (!upgrade) return []
  const t = i18n.global.t
  return [
    {
      id: `mcp-tools:${upgrade.to}`,
      kind: 'update',
      version: upgrade.to,
      title: t('announce.mcp-tools-changed'),
      highlights: [],
      note: t('announce.mcp-tools-changed-note', { from: upgrade.from }),
      read: false,
    },
  ]
}

/** What the backend's `scheduler.job_disabled` event carries: a job it
 *  disabled because its target pane stayed gone, whose owner pane could not be
 *  told (the user owns it, or that pane is gone too). */
export interface SchedulerDisabledNotice {
  id: string
  name: string
  reason: string
  pane_id?: string
  count?: number
}

/** Disabled-job notices this window heard, newest first. Not persisted: the
 *  job's own row in the Schedule panel keeps showing why it stopped. */
const schedulerNotices = ref<{ notice: SchedulerDisabledNotice; at: number }[]>([])

function schedulerAnnouncementId(jobId: string, at: number): string {
  return `scheduler-disabled:${jobId}:${at}`
}

function schedulerItems(): Announcement[] {
  const t = i18n.global.t
  return schedulerNotices.value.map(({ notice, at }) => ({
    id: schedulerAnnouncementId(notice.id, at),
    kind: 'scheduler' as const,
    title: t('announce.scheduler-disabled', { name: notice.name }),
    highlights: [],
    note: t('announce.scheduler-disabled-note', { n: notice.count ?? 0 }),
    createdAt: at,
    read: false,
  }))
}

/** Record a job the backend disabled; the same notice twice is one row. */
function noteSchedulerDisabled(notice: SchedulerDisabledNotice, at: number = Date.now()): void {
  if (!notice?.id) return
  const id = schedulerAnnouncementId(notice.id, at)
  if (schedulerNotices.value.some((n) => schedulerAnnouncementId(n.notice.id, n.at) === id)) return
  schedulerNotices.value = [{ notice, at }, ...schedulerNotices.value]
}

// ── Workspace self-evolution ────────────────────────────────────────────────

export type EvolveNoticeKind =
  | 'started'
  | 'finished'
  | 'timeout'
  | 'failed'
  | 'skipped'
  | 'fallback_auto'
  | 'not_git'
  /** Passed 1.5× the token budget (cache reads left out); Navide interrupted and ended the run. */
  | 'over_budget'

/** What the backend's `evolve.notice` broadcast carries. */
export interface EvolveNotice {
  workspace: string
  kind: EvolveNoticeKind
  run: EvolveRun | null
}

/** Evolve notices this window heard, newest first. Not persisted: the
 *  workspace's evolve panel keeps the run history. */
const evolveNotices = ref<{ notice: EvolveNotice; at: number }[]>([])
const MAX_EVOLVE_NOTICES = 50

function evolveAnnouncementId(notice: EvolveNotice, at: number): string {
  return `evolve:${notice.workspace}:${notice.run?.id ?? at}:${notice.kind}`
}

function workspaceName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function evolveReason(reason: string | null | undefined): string {
  if (!reason) return ''
  const key = `evolve.reason.${reason}`
  return i18n.global.te(key) ? i18n.global.t(key) : reason
}

function evolveActions(notice: EvolveNotice): EvolveAnnouncementAction[] {
  const workspace = notice.workspace
  const paneId = notice.run?.pane_id || undefined
  const pane = (kind: EvolveAnnouncementAction['kind']): EvolveAnnouncementAction[] =>
    paneId ? [{ kind, workspace, paneId }] : []
  switch (notice.kind) {
    case 'started':
    case 'fallback_auto':
    case 'over_budget':
      return pane('evolve-open-pane')
    case 'finished':
      return [{ kind: 'evolve-result', workspace }, ...pane('evolve-resume-pane')]
    case 'timeout':
      return [...pane('evolve-open-pane'), ...pane('evolve-interrupt'), ...pane('evolve-reclaim')]
    default:
      return [{ kind: 'evolve-panel', workspace }]
  }
}

function evolveHighlights(notice: EvolveNotice): string[] {
  const t = i18n.global.t
  const run = notice.run
  const pane = run?.pane_name || run?.pane_id || ''
  const agent = [run?.agent, run?.model].filter(Boolean).join(' · ')
  switch (notice.kind) {
    case 'started':
      return [t('evolve.notice.started-body', { pane, agent })]
    case 'finished': {
      const lines: string[] = []
      if (run?.summary) lines.push(run.summary)
      lines.push(
        t('evolve.notice.finished-body', {
          fixes: run?.commits?.length ?? 0,
          proposals: run?.proposals?.length ?? 0,
          tokens: typeof run?.tokens === 'number' ? `${Math.round(run.tokens / 1000)}k` : '—',
        })
      )
      if (run?.reclaimed) lines.push(t('evolve.notice.reclaimed'))
      return lines
    }
    case 'timeout':
      return [t('evolve.notice.timeout-body')]
    case 'fallback_auto':
      return [t('evolve.notice.fallback-body', { pane })]
    case 'not_git':
      return [t('evolve.notice.not-git-body')]
    case 'over_budget':
      return [t('evolve.notice.over-budget-body')]
    default: {
      const why = evolveReason(run?.reason) || run?.detail || ''
      return why ? [why] : []
    }
  }
}

function evolveItems(): Announcement[] {
  const t = i18n.global.t
  return evolveNotices.value.map(({ notice, at }) => ({
    id: evolveAnnouncementId(notice, at),
    kind: 'evolve' as const,
    title: t(`evolve.notice.${notice.kind}`, { workspace: workspaceName(notice.workspace) }),
    highlights: evolveHighlights(notice),
    note: notice.run?.detail && notice.kind !== 'failed' && notice.kind !== 'skipped' ? notice.run.detail : undefined,
    createdAt: at,
    read: false,
    actions: evolveActions(notice),
  }))
}

/** Record an evolve notice; the same run's same kind twice is one row. */
function noteEvolveNotice(notice: EvolveNotice, at: number = Date.now()): void {
  if (!notice?.workspace || !notice.kind) return
  const id = evolveAnnouncementId(notice, at)
  if (evolveNotices.value.some((n) => evolveAnnouncementId(n.notice, n.at) === id)) return
  evolveNotices.value = [{ notice, at }, ...evolveNotices.value].slice(0, MAX_EVOLVE_NOTICES)
}

/** A share-link event worth telling the user (see useShareNotices): a link
 *  was created, or opened for the first time or by a new viewer. Never the
 *  URL — the key in it belongs to whoever the creator gave it to. */
export interface ShareNotice {
  kind: 'created' | 'opened' | 'feedback'
  linkId: string
  createdBy?: 'user' | 'agent'
  pane?: string
  agent?: string
  maskedTotal?: number
  openCount?: number
  newViewer?: boolean
  /** Phone feedback: approved | noted | already | rejected, and why. */
  title?: string
  result?: string
  reason?: string
}

/** Share notices this window heard, newest first. Not persisted: the Share
 *  tab in Settings is the record. */
const shareNotices = ref<{ notice: ShareNotice; at: number }[]>([])
const MAX_SHARE_NOTICES = 50

function shareItems(): Announcement[] {
  const t = i18n.global.t
  return shareNotices.value.map(({ notice, at }) => {
    const short = notice.linkId.slice(0, 6)
    const highlights: string[] = []
    let title: string
    if (notice.kind === 'created') {
      title =
        notice.createdBy === 'agent'
          ? t('share.notice.created-agent', { pane: notice.pane || '—', id: short })
          : t('share.notice.created-user', { id: short })
      if (notice.maskedTotal) highlights.push(t('share.notice.masked', { count: notice.maskedTotal }))
    } else if (notice.kind === 'feedback') {
      const name = notice.title || short
      const result = ['approved', 'noted', 'already', 'rejected'].includes(notice.result ?? '') ? notice.result : 'rejected'
      title = t(`share.notice.feedback-${result}`, { title: name })
      if (result === 'rejected') {
        highlights.push(
          notice.reason === 'content-changed'
            ? t('share.notice.reason-content-changed')
            : t('share.notice.reason-other', { reason: notice.reason || '—' })
        )
      }
    } else {
      title = notice.newViewer ? t('share.notice.opened-new-viewer', { id: short }) : t('share.notice.opened-first', { id: short })
      highlights.push(t('share.notice.open-count', { count: notice.openCount ?? 0 }))
    }
    return { id: `share:${notice.kind}:${notice.linkId}:${at}`, kind: 'share' as const, title, highlights, createdAt: at, read: false }
  })
}

/** Record a share notice. */
function noteShareNotice(notice: ShareNotice, at: number = Date.now()): void {
  if (!notice?.linkId) return
  shareNotices.value = [{ notice, at }, ...shareNotices.value].slice(0, MAX_SHARE_NOTICES)
}

// ── Agent plugin actions (B2-c) ─────────────────────────────────────────────

/** An agent disabled, enabled or updated a Navide plugin, as the Host reported it. */
export interface PluginAgentNotice {
  action: 'disable' | 'enable' | 'update'
  pluginId: string
  pluginVersion: string
  /** `update` only: the version it was updated from. */
  fromVersion?: string
  requester: { paneId: string | null; paneName: string | null; workspace: string | null; callerKind: 'pane' | 'external' | 'host' }
}

/** Notices this window heard, newest first. Not persisted: the activity page
 *  (plugin_agent_actions) is the record. */
const pluginAgentNotices = ref<{ notice: PluginAgentNotice; at: number }[]>([])

/** Who did it, for the row and the toast: the pane's name, or the kind of caller. */
export function pluginAgentCaller(requester: PluginAgentNotice['requester']): string {
  const t = i18n.global.t
  if (requester.callerKind === 'external') return t('plugin-agent.caller.external')
  if (requester.callerKind === 'host') return t('plugin-agent.caller.host')
  return requester.paneName ? t('plugin-agent.caller.pane', { pane: requester.paneName }) : t('plugin-agent.caller.pane-unknown')
}

/** One line naming the caller, what it did and the plugin. */
export function pluginAgentNoticeTitle(notice: PluginAgentNotice): string {
  if (notice.action === 'update') {
    return i18n.global.t('plugin-agent.notice.updated', {
      caller: pluginAgentCaller(notice.requester),
      plugin: notice.pluginId,
      from: notice.fromVersion ?? '',
      to: notice.pluginVersion,
    })
  }
  return i18n.global.t(`plugin-agent.notice.${notice.action === 'disable' ? 'disabled' : 'enabled'}`, {
    caller: pluginAgentCaller(notice.requester),
    plugin: notice.pluginId,
  })
}

function pluginAgentItems(): Announcement[] {
  return pluginAgentNotices.value.map(({ notice, at }) => ({
    id: `plugin-agent:${notice.action}:${notice.pluginId}:${at}`,
    kind: 'plugin-agent' as const,
    title: pluginAgentNoticeTitle(notice),
    highlights: [
      notice.action === 'update'
        ? i18n.global.t('plugin-agent.notice.updated-detail', { from: notice.fromVersion ?? '', to: notice.pluginVersion })
        : i18n.global.t('plugin-agent.notice.version', { version: notice.pluginVersion }),
    ],
    createdAt: at,
    read: false,
    actions: [
      notice.action === 'update'
        ? {
            kind: 'plugin-agent-downgrade' as const,
            pluginId: notice.pluginId,
            fromVersion: notice.fromVersion ?? '',
            toVersion: notice.pluginVersion,
          }
        : { kind: 'plugin-agent-undo' as const, pluginId: notice.pluginId, disable: notice.action === 'enable' },
    ],
  }))
}

/** Whether the undo still sets back what the agent did: the package is still
 *  in the state the agent left it in (the user has not changed it since). */
export function pluginAgentUndoApplies(
  action: Extract<PluginAgentAnnouncementAction, { kind: 'plugin-agent-undo' }>,
  installed: ReadonlyArray<{ id: string; disabled?: boolean }>,
): boolean {
  const current = installed.find((pkg) => pkg.id === action.pluginId)
  // The undo enables when the agent disabled, and the other way round.
  return current !== undefined && current.disabled === !action.disable
}

/** How the downgrade of an agent's update (O1) sets it back, or null when the
 *  package was changed since: the update still waiting for a restart is
 *  dropped, an update in use is rolled back to the version it replaced. */
export function pluginAgentDowngradeStep(
  action: Extract<PluginAgentAnnouncementAction, { kind: 'plugin-agent-downgrade' }>,
  installed: ReadonlyArray<{ id: string; packageVersion?: string; pendingCandidateVersion?: string; rollbackToVersion?: string }>,
): 'discard' | 'rollback' | null {
  const current = installed.find((pkg) => pkg.id === action.pluginId)
  if (!current) return null
  if (current.pendingCandidateVersion === action.toVersion && current.packageVersion === action.fromVersion) return 'discard'
  if (!current.pendingCandidateVersion && current.packageVersion === action.toVersion && current.rollbackToVersion === action.fromVersion) {
    return 'rollback'
  }
  return null
}

/** Record that an agent disabled or enabled a Navide plugin. */
function notePluginAgentNotice(notice: PluginAgentNotice, at: number = Date.now()): void {
  if (!notice?.pluginId) return
  pluginAgentNotices.value = [{ notice, at }, ...pluginAgentNotices.value]
}

// ── Staged plugin packages ──────────────────────────────────────────────────

/** A package staged beside the active one, as the Host found it at launch. */
export interface PluginStagedUpdate {
  pluginId: string
  activeVersion: string
  stagedVersion: string
}

/** One row per staged package, kept until it is applied or found changed.
 *  Not persisted: the Host reports them again on the next launch. */
const pluginStagedUpdates = ref<PluginStagedUpdate[]>([])

function pluginStagedItems(): Announcement[] {
  const t = i18n.global.t
  return pluginStagedUpdates.value.map((update) => ({
    id: `plugin-staged:${update.pluginId}:${update.stagedVersion}`,
    kind: 'plugin-staged' as const,
    title: t('plugin-staged.notice.title', {
      plugin: update.pluginId,
      staged: update.stagedVersion,
      active: update.activeVersion,
    }),
    highlights: [t('plugin-staged.notice.detail')],
    read: false,
    actions: [{ kind: 'plugin-staged-apply' as const, ...update }],
  }))
}

/** Whether applying still means what the row says: the same version is still
 *  staged beside the same active one. */
export function pluginStagedApplyApplies(
  action: Extract<PluginAgentAnnouncementAction, { kind: 'plugin-staged-apply' }>,
  installed: ReadonlyArray<{ id: string; packageVersion?: string; pendingCandidateVersion?: string }>,
): boolean {
  const current = installed.find((pkg) => pkg.id === action.pluginId)
  return current?.pendingCandidateVersion === action.stagedVersion && current.packageVersion === action.activeVersion
}

/** Replace the staged packages with what the Host found. */
function notePluginStagedUpdates(updates: PluginStagedUpdate[]): void {
  pluginStagedUpdates.value = updates.filter((update) => update?.pluginId)
}

/** Drop the row of a package that was applied or changed since. */
function dropPluginStagedUpdate(pluginId: string): void {
  pluginStagedUpdates.value = pluginStagedUpdates.value.filter((update) => update.pluginId !== pluginId)
}

// ── Plugin version switches (L3) ────────────────────────────────────────────

/** An update the user approved took effect at once, as the Host reported it. */
export interface PluginSwitchNotice {
  pluginId: string
  fromVersion: string
  toVersion: string
  source: 'marketplace' | 'local-unsigned'
  at: number
}

/** Switches this window heard, newest first. Not persisted: the plugin
 *  activity record and the installed list are the durable state. */
const pluginSwitchNotices = ref<PluginSwitchNotice[]>([])

function pluginSwitchItems(): Announcement[] {
  const t = i18n.global.t
  return pluginSwitchNotices.value.map((notice) => ({
    id: `plugin-switch:${notice.pluginId}:${notice.toVersion}:${notice.at}`,
    kind: 'plugin-switch' as const,
    title: t('plugin-switch.notice.title', { plugin: notice.pluginId, from: notice.fromVersion, to: notice.toVersion }),
    highlights: [
      t('plugin-switch.notice.detail', {
        time: new Date(notice.at).toLocaleTimeString(),
        source: t(notice.source === 'local-unsigned' ? 'plugin-switch.source.local' : 'plugin-switch.source.marketplace'),
      }),
    ],
    createdAt: notice.at,
    read: false,
    actions: [{
      kind: 'plugin-switch-back' as const,
      pluginId: notice.pluginId,
      fromVersion: notice.fromVersion,
      toVersion: notice.toVersion,
    }],
  }))
}

/** Whether going back still means what the row says: the switched-to version
 *  is the one running and the one it replaced is the rollback target. */
export function pluginSwitchBackApplies(
  action: Extract<PluginAgentAnnouncementAction, { kind: 'plugin-switch-back' }>,
  installed: ReadonlyArray<{ id: string; packageVersion?: string; pendingCandidateVersion?: string; rollbackToVersion?: string }>,
): boolean {
  const current = installed.find((pkg) => pkg.id === action.pluginId)
  return current?.packageVersion === action.toVersion && !current.pendingCandidateVersion &&
    current.rollbackToVersion === action.fromVersion
}

/** Record that an approved update switched versions. */
function notePluginSwitch(notice: PluginSwitchNotice): void {
  if (!notice?.pluginId) return
  pluginSwitchNotices.value = [notice, ...pluginSwitchNotices.value]
}

// ── Convenience features ────────────────────────────────────────────────────

/** The last `convenience.list` useConvenience read. Not persisted: the
 *  backend's log is the record, and it is re-read on every connect. */
const convenienceState = shallowRef<ConvenienceSnapshot | null>(null)
const convenienceAgentLabel = shallowRef<(agentKey: string) => string>((key) => key)

export const CONVENIENCE_UPGRADE_ID = 'convenience:upgrade'

/** `detail` of a credentials.auto-repair prompt entry (a JSON string). */
interface ConveniencePromptDetail {
  agentKey?: string
  slotId?: string | null
  slotLabel?: string
  liveEmail?: string
  slotEmail?: string
  /** Hash of the live login the prompt is about; the switch-back sends it
   *  back and the backend refuses it once another login is live. */
  liveFingerprint?: string
  /** "logout": the user signed out outside Navide; no slot to switch back to. */
  reason?: string
}

function parsePromptDetail(detail: string): ConveniencePromptDetail {
  try {
    const parsed = JSON.parse(detail) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ConveniencePromptDetail) : {}
  } catch {
    return {}
  }
}

export function convenienceAnnouncementId(entryId: number): string {
  return `convenience:${entryId}`
}

function convenienceItems(seen: Set<string>): Announcement[] {
  const state = convenienceState.value
  if (!state) return []
  const t = i18n.global.t
  const overview: ConvenienceAnnouncementAction = { kind: 'convenience-overview' }
  const items: Announcement[] = []
  if (state.upgrade && state.upgrade.features.length > 0) {
    items.push({
      id: CONVENIENCE_UPGRADE_ID,
      kind: 'convenience',
      title: t('convenience.notice.upgrade'),
      highlights: state.upgrade.features.map((id) => convenienceText(id, 'name')),
      note: t('convenience.notice.upgrade-note'),
      read: false,
      actions: [{ kind: 'convenience-upgrade-ack' }, overview],
    })
  }
  const entries = state.notices.filter((entry) => entry.notify).slice().sort((a, b) => b.at - a.at || b.id - a.id)
  for (const entry of entries) {
    const id = convenienceAnnouncementId(entry.id)
    const feature = convenienceText(entry.feature, 'name')
    const actions: ConvenienceAnnouncementAction[] = []
    let title: string
    let note: string | undefined
    const highlights: string[] = []
    switch (entry.action) {
      case 'first':
      case 'repair':
        title = t('convenience.notice.wrote', { feature, target: entry.target, purpose: convenienceText(entry.feature, 'purpose') })
        if (entry.action === 'repair') note = t('convenience.notice.repair-note')
        break
      case 'reset':
        title = t('convenience.notice.reset', { feature, target: entry.target, purpose: convenienceText(entry.feature, 'purpose') })
        note = t('convenience.notice.reset-note')
        break
      case 'removed': {
        title = t('convenience.notice.removed', { feature, target: entry.target })
        const current = state.features.find((f) => f.id === entry.feature)
        // Offered only while the removal is still what keeps it off.
        if (current?.state === 'off' && current.reason === 'removed') {
          actions.push({ kind: 'convenience-reallow', featureId: entry.feature })
        }
        break
      }
      case 'prompt': {
        const detail = parsePromptDetail(entry.detail)
        const agentKey = detail.agentKey || entry.target
        if (detail.reason === 'logout') {
          // Navide did not sign the user back in; there is nothing to choose.
          const agent = convenienceAgentLabel.value(agentKey)
          title = t('convenience.notice.prompt-logout', { agent })
          note = t('convenience.notice.prompt-logout-note', { agent })
          if (!seen.has(id)) actions.push({ kind: 'convenience-dismiss', rowId: id })
          break
        }
        const label = detail.slotLabel || detail.slotEmail || ''
        title = t('convenience.notice.prompt', { agent: convenienceAgentLabel.value(agentKey) })
        if (detail.liveEmail || label) {
          highlights.push(t('convenience.notice.prompt-accounts', { live: detail.liveEmail || '?', slot: label || '?' }))
        }
        note = t('convenience.notice.prompt-note')
        // A prompt is answered once: reading the row is the answer "keep"
        // (Navide already follows the live account). Switching back needs the
        // slot the prompt names; a missing one must never become a switch to
        // Default, so then only "keep" is offered. The same goes for the live
        // login's fingerprint, without which the backend refuses the switch.
        if (!seen.has(id)) {
          actions.push({ kind: 'convenience-keep-login', rowId: id })
          if (typeof detail.slotId === 'string' && detail.slotId && typeof detail.liveFingerprint === 'string') {
            actions.push({
              kind: 'convenience-switch-back', rowId: id, agentKey, slotId: detail.slotId, label,
              liveFingerprint: detail.liveFingerprint,
            })
          }
        }
        break
      }
      case 'refused-name': {
        // The target is the link Navide did not create: its folder, then its name.
        const cut = Math.max(entry.target.lastIndexOf('/'), entry.target.lastIndexOf('\\'))
        title = t('convenience.notice.action.refused-name', {
          feature, name: entry.target.slice(cut + 1), target: entry.target.slice(0, Math.max(cut, 0)),
        })
        break
      }
      // 'refused-unsafe' among them: a workspace left alone for safety; and
      // 'refused-exclude': a git exclude behind a link, left unwritten.
      default:
        title = t(`convenience.notice.action.${entry.action}`, { feature, target: entry.target })
    }
    actions.push(overview)
    items.push({ id, kind: 'convenience', title, highlights, note, createdAt: entry.at * 1000, read: false, actions })
  }
  return items
}

/** Hand in the latest `convenience.list` (useConvenience does, on every read). */
function noteConvenience(snapshot: ConvenienceSnapshot): void {
  convenienceState.value = snapshot
}

/** How the account prompt names a CLI (App.vue passes the agent specs' labels). */
function setConvenienceAgentLabel(label: (agentKey: string) => string): void {
  convenienceAgentLabel.value = label
}

/** Live quota incidents by id, newest update first when listed. Not
 *  persisted: the backend owns the incidents and re-publishes them on
 *  connect, and a stale copy in ui_settings would offer buttons for an epoch
 *  that is gone. */
const quotaIncidents = ref<Map<string, QuotaIncidentNotice>>(new Map())
/** Incidents whose buttons were withdrawn without the row going away. */
const quotaInvalidated = ref<Set<string>>(new Set())
/** Per-window read marks for quota rows: `<status>@<epoch>` the user last
 *  read, so a status change or a new epoch surfaces the row unread again. */
const quotaReadMarks = ref<Map<string, string>>(new Map())

const QUOTA_ID_PREFIX = 'quota:'

export function quotaAnnouncementId(incidentId: string): string {
  return `${QUOTA_ID_PREFIX}${incidentId}`
}

function quotaReadKey(notice: QuotaIncidentNotice): string {
  return `${notice.status}@${notice.epoch}`
}

/** i18n with an English fallback for keys the locale files do not carry yet:
 *  vue-i18n prints the raw key for a missing one, and a status line reading
 *  "announce.quota.status.ready" is worse than English. The fallback set is
 *  what the locale files are expected to grow (see QUOTA_I18N_KEYS). */
function tq(key: string, fallback: string, params: Record<string, string | number> = {}): string {
  if (i18n.global.te(key)) return i18n.global.t(key, params)
  return fallback.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
}

const QUOTA_STATUS_FALLBACK: Record<QuotaIncidentStatus, string> = {
  detected: '{agent}: {source} has run out of quota',
  'awaiting-confirmation': '{agent}: switching to {target} needs your confirmation',
  'waiting-safe': '{agent}: waiting for a safe moment to switch to {target}',
  switching: '{agent}: switching to {target}',
  settling: '{agent}: switched to {target}, verifying quota',
  ready: '{agent}: switched to {target}',
  partial: '{agent}: switched to {target}, some panes did not resume',
  'notify-stopped': '{agent}: automatic switch stopped',
  unreconciled: '{agent}: an account switch was not reconciled',
}

/** Sentences for the backend's Incident.reason values. Keyed by the enum
 *  verbatim; an unlisted value is printed as-is. */
const QUOTA_REASON_FALLBACK: Record<string, string> = {
  // notify-stopped
  unsupported: '{agent} has no account switching yet.',
  'manual-only': '{agent} can only be switched manually.',
  'unverified-adapter': '{agent}\'s account switching is not verified on this platform; switch manually.',
  'no-resume': '{agent} cannot resume its conversation automatically. Switch manually to keep this window and open a new conversation.',
  'no-candidate': 'No account to switch to. Sign in to another account or wait for the reset.',
  auto_budget_exhausted: 'Automatic switch limit reached. Switch manually or wait for the window to pass.',
  'chained-exhaustion': '{target} ran out as well. Nothing else was tried.',
  'pane-unowned': 'A pane in this switch belongs to no open window.',
  'pane-no-session': 'A pane has no session to resume, so nothing was switched.',
  'pane-not-resumable': 'A pane cannot be resumed, so nothing was switched.',
  'pane-refused': 'A pane refused the switch, so nothing was switched.',
  'pane-unsupported': 'A pane cannot take part in a switch, so nothing was switched.',
  'pane-input-pending': 'A pane holds unsent input, so nothing was switched.',
  'pane-permission-pending': 'A pane is waiting on a permission prompt, so nothing was switched.',
  'pane-resume-data-missing': 'A pane could not name the session to resume, so nothing was switched.',
  'pane-idle-unverified': 'A pane\'s idle state could not be verified, so nothing was switched.',
  'platform-unsupported': '{agent}\'s account switching is not available on this platform.',
  'identity-unknown': 'The account behind the current sign-in could not be identified, so nothing was switched.',
  'credential-override': 'The panes take their credential from the environment; a switch would not reach them.',
  'pane-scope-unknown': 'A pane\'s provider scope is unknown, so nothing was switched.',
  'credential-source-unknown': 'Where {agent}\'s credential comes from could not be determined (environment variable or provider scope), so nothing was switched.',
  'live-drift': 'The live credential belongs to another account and the target slot is not empty; reconcile before switching.',
  'live-drift-unverified': 'The live credential changed and its identity cannot be verified; nothing was switched. Switch manually to confirm which account is live.',
  'audit-write-failed': 'Credentials were switched but the audit record could not be written; automatic switching pauses until it can.',
  'incident-closed': 'The incident was closed before the switch completed.',
  'interrupted-swap': 'A credential swap was interrupted; which account is live is unknown. Pick the live one to reconcile.',
  'unreconciled': 'An earlier switch left the saved default and the live account out of step; reconcile before switching again.',
  'identity-mismatch': 'The account you picked does not match the credential that is live ({identity}).',
  'persist-failed': 'The default could not be saved again; the switch stays unreconciled.',
  'prepare-timeout': 'Not every pane answered in time, so nothing was switched.',
  'wait-timeout': 'Panes stayed busy for 30 minutes, so nothing was switched.',
  'stale-state': 'The account changed underneath the switch, so it was dropped.',
  'new-pane-during-prepare': 'A new pane opened during the switch, so it was dropped.',
  'pane-became-busy': 'A pane became busy during the switch, so it was dropped.',
  'login-pending': 'A sign-in is in progress; switch after it completes.',
  'login-harvest-failed': 'The current sign-in could not be saved, so nothing was switched.',
  'target-signed-out': '{target} is not signed in.',
  'target-expired': '{target}\'s sign-in has expired.',
  'target-login-pending': '{target} is still signing in.',
  'swap-failed': 'Switching to {target} failed; {source} is still active. Nothing else was tried.',
  'default-persist-failed': 'Credentials were switched but the default could not be saved; check Settings before continuing.',
  'resume-failed': 'Switched to {target}, but resuming failed. Panes keep their state; nothing was replayed.',
  'target-exhausted': '{target} is out of quota too. Nothing else was tried.',
  'quota-unconfirmed': 'Switched to {target}, but no reading confirmed its quota within 120 s. Later readings only update this row.',
  'manual-switch': 'A manual switch took over.',
  'policy-changed': 'Automatic switching was turned off during the switch.',
  'user-cancelled': 'Cancelled.',
  // ready
  'quota-confirmed': '{target}\'s quota was read and has headroom.',
  'turn-complete': '{target} completed a turn after the switch; its quota was not read.',
  'outgoing-recovered': '{source} recovered on its own; no switch was needed.',
  // untrusted
  unattributed: 'The signal could not be tied to an account, so nothing was switched.',
  'usage-window-disagrees': 'The account\'s own reading does not show the quota as spent, so nothing was switched.',
  'no-declared-detector': '{agent} declares no exhaustion signal, so this text only informs.',
  'text-did-not-match': 'The text did not match {agent}\'s declared exhaustion signal, so nothing was switched.',
}

const QUOTA_CAUSE_FALLBACK: Record<FailureCause, string> = {
  'quota-exhausted': 'Quota exhausted',
  'rate-limited': 'Rate limited (temporary)',
  auth: 'Sign-in problem',
  network: 'Network error',
  context: 'Context window full',
  payment: 'Billing problem',
  'low-quota-warning': 'Quota running low',
  unknown: 'Unclassified failure',
}

const QUOTA_TIER_FALLBACK: Record<CandidateTier, string> = {
  'fresh-headroom': 'quota available',
  'reset-expected': 'reset expected, unverified',
  'stale-headroom': 'had quota at last reading',
  unknown: 'no reading',
}

const QUOTA_EXCLUDED_FALLBACK: Record<QuotaExcludedReason, string> = {
  current: 'current account',
  'signed-out': 'not signed in',
  expired: 'sign-in expired',
  'login-pending': 'signing in',
  'limit-not-reset': 'a limit has not reset',
  exhausted: 'a limit has not reset',
  tried: 'already tried this round',
  'wrong-scope': 'different authentication scope',
}

/** The locale keys the quota rows read, for the integration step that adds
 *  them to en-US.json / zh-TW.json. Each maps to the English used meanwhile. */
export const QUOTA_I18N_KEYS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(Object.entries(QUOTA_STATUS_FALLBACK).map(([k, v]) => [`announce.quota.status.${k}`, v])),
  ...Object.fromEntries(Object.entries(QUOTA_REASON_FALLBACK).map(([k, v]) => [`announce.quota.reason.${k}`, v])),
  ...Object.fromEntries(Object.entries(QUOTA_CAUSE_FALLBACK).map(([k, v]) => [`announce.quota.cause.${k}`, v])),
  ...Object.fromEntries(Object.entries(QUOTA_TIER_FALLBACK).map(([k, v]) => [`announce.quota.tier.${k}`, v])),
  ...Object.fromEntries(Object.entries(QUOTA_EXCLUDED_FALLBACK).map(([k, v]) => [`announce.quota.excluded.${k}`, v])),
  'announce.quota.scope': 'Affects {workspaces} workspace(s), {panes} pane(s) · {scope}',
  'announce.quota.candidate': '{label} — {tier}',
  'announce.quota.candidate-detail': '{label} — {tier} · {detail}',
  'announce.quota.excluded-line': '{label} — {reason}',
  'announce.quota.reset-expected': '{source} is expected back around {time} (not verified). No automatic switch back.',
  'announce.quota.actions-withdrawn': 'These options are no longer current.',
  'announce.quota.untrusted': 'Not verified: no switch was started.',
  'announce.quota.not-switched': '{count} pane(s) not switched: their credential comes from the environment.',
  'announce.quota.blocked': 'Account switching for this CLI is paused until the earlier switch is reconciled.',
  'announce.quota.reconcile': 'Complete reconciliation',
  'announce.quota.reconcile-as': 'The live account is {label}',
  'announce.quota.switch-to': 'Switch to {label}',
  'announce.quota.retry-resume': 'Retry resume',
  'announce.quota.switch-back': 'Switch back to {label}',
  'announce.quota.switch-refused': 'Account switch refused ({code}): {message}',
  'announce.quota.confirm-new-conversation-title': 'Open a new conversation?',
  'announce.quota.confirm-new-conversation-body': '{agent} cannot resume its conversation on another account. Switching to {target} keeps this pane as it is (on the old account, not resumed) and opens a new conversation on {target}. Credentials change only if you confirm.',
  'announce.quota.confirm-new-conversation-confirm': 'Keep this pane and open a new conversation',
  'announce.quota.confirm-new-conversation-cancel': 'Cancel, keep the current account',
})

function quotaActionsFor(notice: QuotaIncidentNotice): QuotaAnnouncementAction[] {
  if (quotaInvalidated.value.has(notice.incidentId)) return []
  const actions: QuotaAnnouncementAction[] = []
  if (notice.reconcile) {
    for (const choice of notice.reconcile.choices) {
      actions.push({
        kind: 'quota-reconcile',
        incidentId: notice.incidentId,
        agentKey: notice.agentKey,
        transactionId: notice.reconcile.transactionId,
        liveSlotId: choice.slotId,
        label: choice.label,
      })
    }
    return actions
  }
  if (notice.blockedReason) return []
  const base = { incidentId: notice.incidentId, agentKey: notice.agentKey, epoch: notice.epoch }
  if (notice.untrusted) return []
  if (notice.status === 'detected' || notice.status === 'notify-stopped') {
    for (const c of notice.candidates ?? []) {
      actions.push({ kind: 'quota-switch', ...base, slotId: c.slotId, label: c.label, tier: c.tier })
    }
  }
  if (notice.retryResume && notice.status === 'partial') {
    actions.push({ kind: 'quota-retry-resume', ...base })
  }
  if (notice.switchBack && (notice.status === 'ready' || notice.status === 'partial' || notice.status === 'notify-stopped')) {
    actions.push({ kind: 'quota-switch-back', ...base, slotId: notice.switchBack.slotId, label: notice.switchBack.label })
  }
  return actions
}

function quotaItems(): Announcement[] {
  const notices = [...quotaIncidents.value.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  return notices.map((notice) => {
    const params = { agent: notice.agentLabel, source: notice.sourceLabel, target: notice.targetLabel ?? '' }
    const highlights: string[] = [
      tq('announce.quota.scope', QUOTA_I18N_KEYS['announce.quota.scope'], {
        workspaces: notice.affected.workspaces,
        panes: notice.affected.panes,
        scope: notice.authScope,
      }),
      tq(`announce.quota.cause.${notice.cause}`, QUOTA_CAUSE_FALLBACK[notice.cause]),
    ]
    for (const c of notice.candidates ?? []) {
      const tier = tq(`announce.quota.tier.${c.tier}`, QUOTA_TIER_FALLBACK[c.tier])
      highlights.push(
        c.detail
          ? tq('announce.quota.candidate-detail', QUOTA_I18N_KEYS['announce.quota.candidate-detail'], { label: c.label, tier, detail: c.detail })
          : tq('announce.quota.candidate', QUOTA_I18N_KEYS['announce.quota.candidate'], { label: c.label, tier }),
      )
    }
    for (const e of notice.excluded ?? []) {
      highlights.push(
        tq('announce.quota.excluded-line', QUOTA_I18N_KEYS['announce.quota.excluded-line'], {
          label: e.label,
          reason: tq(`announce.quota.excluded.${e.reason}`, QUOTA_EXCLUDED_FALLBACK[e.reason]),
        }),
      )
    }
    const notes: string[] = []
    if (notice.untrusted) {
      notes.push(tq('announce.quota.untrusted', QUOTA_I18N_KEYS['announce.quota.untrusted']))
    }
    if (notice.reason) {
      notes.push(tq(`announce.quota.reason.${notice.reason}`, QUOTA_REASON_FALLBACK[notice.reason] ?? notice.reason, params))
    }
    if (notice.resetExpectedAt) {
      notes.push(
        tq('announce.quota.reset-expected', QUOTA_I18N_KEYS['announce.quota.reset-expected'], {
          source: notice.sourceLabel,
          time: new Date(notice.resetExpectedAt).toLocaleString(),
        }),
      )
    }
    if (notice.blockedReason) {
      notes.push(tq(`announce.quota.reason.${notice.blockedReason}`, QUOTA_REASON_FALLBACK[notice.blockedReason] ?? notice.blockedReason, params))
      notes.push(tq('announce.quota.blocked', QUOTA_I18N_KEYS['announce.quota.blocked']))
    }
    if (notice.notSwitchedPanes) {
      notes.push(tq('announce.quota.not-switched', QUOTA_I18N_KEYS['announce.quota.not-switched'], { count: notice.notSwitchedPanes }))
    }
    if (quotaInvalidated.value.has(notice.incidentId)) {
      notes.push(tq('announce.quota.actions-withdrawn', QUOTA_I18N_KEYS['announce.quota.actions-withdrawn']))
    }
    const actions = quotaActionsFor(notice)
    return {
      id: quotaAnnouncementId(notice.incidentId),
      kind: 'quota' as const,
      title: tq(`announce.quota.status.${notice.status}`, QUOTA_STATUS_FALLBACK[notice.status], params),
      highlights,
      note: notes.length > 0 ? notes.join(' ') : undefined,
      createdAt: notice.observedAt,
      read: quotaReadMarks.value.get(notice.incidentId) === quotaReadKey(notice),
      actions: actions.length > 0 ? actions : undefined,
      quota: notice,
    }
  })
}

/** Insert or update the row for `notice.incidentId`. An update older than
 *  the one on screen (two windows relaying the same backend event out of
 *  order) is dropped; a status or epoch change surfaces the row unread and
 *  replaces every button, so nothing offered under the old state survives. */
function noteQuotaIncident(notice: QuotaIncidentNotice): void {
  const current = quotaIncidents.value.get(notice.incidentId)
  if (current && notice.updatedAt < current.updatedAt) return
  const next = new Map(quotaIncidents.value)
  next.set(notice.incidentId, notice)
  quotaIncidents.value = next
  if (current && (current.epoch !== notice.epoch || current.status !== notice.status) && quotaInvalidated.value.has(notice.incidentId)) {
    // A withdrawal applied to the previous state; the new state's buttons
    // are the backend's fresh offer.
    const cleared = new Set(quotaInvalidated.value)
    cleared.delete(notice.incidentId)
    quotaInvalidated.value = cleared
  }
}

/** Withdraw the buttons of an incident whose row should stay (a candidate
 *  was deleted, a manual switch overtook it) without a new notice. */
function invalidateQuotaActions(incidentId: string): void {
  if (!quotaIncidents.value.has(incidentId) || quotaInvalidated.value.has(incidentId)) return
  quotaInvalidated.value = new Set(quotaInvalidated.value).add(incidentId)
}

/** Drop the row entirely (the backend closed the incident). */
function dismissQuotaIncident(incidentId: string): void {
  if (!quotaIncidents.value.has(incidentId)) return
  const next = new Map(quotaIncidents.value)
  next.delete(incidentId)
  quotaIncidents.value = next
  const marks = new Map(quotaReadMarks.value)
  marks.delete(incidentId)
  quotaReadMarks.value = marks
  const cleared = new Set(quotaInvalidated.value)
  cleared.delete(incidentId)
  quotaInvalidated.value = cleared
}

function markQuotaRead(id: string): boolean {
  if (!id.startsWith(QUOTA_ID_PREFIX)) return false
  const incidentId = id.slice(QUOTA_ID_PREFIX.length)
  const notice = quotaIncidents.value.get(incidentId)
  if (!notice) return true
  const key = quotaReadKey(notice)
  if (quotaReadMarks.value.get(incidentId) === key) return true
  quotaReadMarks.value = new Map(quotaReadMarks.value).set(incidentId, key)
  return true
}

const items: ComputedRef<Announcement[]> = computed(() => {
  // Read the locale so a language switch re-localizes the whole feed.
  const locale = i18n.global.locale.value
  const seen = new Set(readIds.value)
  const merged = [
    ...convenienceItems(seen),
    ...pluginAgentItems(),
    ...pluginStagedItems(),
    ...pluginSwitchItems(),
    ...shareItems(),
    ...evolveItems(),
    ...schedulerItems(),
    ...backendItems(),
    ...updateItems(updateSource.value?.state.value ?? null),
    ...releaseItems(locale, appVersion.value),
  ].map((item) => ({ ...item, read: seen.has(item.id) }))
  // Quota rows first: they are the only ones that ask for a decision now.
  return [...quotaItems(), ...merged]
})

const unreadCount = computed(() => items.value.filter((item) => !item.read).length)

function persist(ids: string[]): void {
  readIds.value = ids.slice(-MAX_READ_IDS)
  settingsSet(READ_IDS_KEY, readIds.value)
}

function markRead(id: string): void {
  if (markQuotaRead(id)) return
  if (readIds.value.includes(id)) return
  persist([...readIds.value, id])
}

function markAllRead(): void {
  const unread = items.value.filter((item) => !item.read).map((item) => item.id)
  if (unread.length === 0) return
  const persisted = unread.filter((id) => !markQuotaRead(id))
  if (persisted.length === 0) return
  // persist() truncates to the TAIL, so append oldest-first: `items` is
  // newest-first, and a batch bigger than MAX_READ_IDS would otherwise drop the
  // newest ids and resurrect them as unread.
  persist([...readIds.value, ...persisted.reverse()])
}

/** Hand the live updater state in (call once, right after useUpdater()). */
function setUpdateSource(state: Ref<UpdateState>): void {
  updateSource.value = { state }
}

/** Record that this backend started at a different version than the last one.
 *  Idempotent: the backend reports it on every connect, and a reconnect must
 *  not resurrect an item the user has already read. */
function noteBackendUpgrade(from: string, to: string): void {
  if (!from || !to || from === to) return
  const current = backendUpgrade.value
  if (current && current.from === from && current.to === to) return
  backendUpgrade.value = { from, to }
}

function load(): void {
  if (loaded) return
  loaded = true
  const stored = settingsGet<unknown>(READ_IDS_KEY, null)
  if (Array.isArray(stored)) {
    readIds.value = stored.filter((id): id is string => typeof id === 'string')
    return
  }
  // No stored set at all — a fresh install. Baseline everything on screen as
  // read (like App.vue does for the What's New watermark) so a new user isn't
  // greeted by every historical release note at once.
  persist(items.value.filter((item) => item.kind !== 'quota').map((item) => item.id).reverse())
}

/** Test-only: forget every quota incident (the module is a singleton). */
export function __resetQuotaAnnouncementsForTest(): void {
  quotaIncidents.value = new Map()
  quotaInvalidated.value = new Set()
  quotaReadMarks.value = new Map()
}

/** Test-only: forget every share notice (the module is a singleton). */
export function __resetShareAnnouncementsForTest(): void {
  shareNotices.value = []
}

/** Test-only: forget every agent plugin notice (the module is a singleton). */
export function __resetPluginAgentAnnouncementsForTest(): void {
  pluginAgentNotices.value = []
}

/** Test-only: forget every staged package row (the module is a singleton). */
export function __resetPluginStagedAnnouncementsForTest(): void {
  pluginStagedUpdates.value = []
}

/** Test-only: forget every version switch row (the module is a singleton). */
export function __resetPluginSwitchAnnouncementsForTest(): void {
  pluginSwitchNotices.value = []
}

/** Test-only: forget the convenience snapshot (the module is a singleton). */
export function __resetConvenienceAnnouncementsForTest(): void {
  convenienceState.value = null
  convenienceAgentLabel.value = (key) => key
}

/** Test-only: forget every evolve notice (the module is a singleton). */
export function __resetEvolveAnnouncementsForTest(): void {
  evolveNotices.value = []
}

export function useAnnouncements() {
  load()
  return {
    items,
    unreadCount,
    markRead,
    markAllRead,
    setUpdateSource,
    noteBackendUpgrade,
    noteSchedulerDisabled,
    noteEvolveNotice,
    noteShareNotice,
    notePluginAgentNotice,
    notePluginStagedUpdates,
    dropPluginStagedUpdate,
    notePluginSwitch,
    noteConvenience,
    setConvenienceAgentLabel,
    noteQuotaIncident,
    invalidateQuotaActions,
    dismissQuotaIncident,
  }
}
