// Workspace self-evolution ("自我優化"): one daily run per workspace, owned by
// the app. The backend owns the settings, the clock job and the run history
// (`evolve.*` RPC, `evolve.changed` / `evolve.notice` broadcasts); this module
// only mirrors them for the sidebar badge, the panel and the announcements.
//
// Module-level singleton state, like useAnnouncements: the sidebar heading in
// ControlPane, the Schedule panel row and App.vue all read the same badges and
// open the same panel without prop drilling. App.vue calls useEvolve(backend)
// once; that binds the backend the badge refresh uses and subscribes to the
// two broadcasts.
import { getCurrentScope, onScopeDispose, readonly, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from './useBackend'
import { useAnnouncements, type EvolveNotice, type EvolveNoticeKind } from './useAnnouncements'

type Backend = ReturnType<typeof useBackend>

export interface EvolveSettings {
  enabled: boolean
  /** "HH:MM", daily. */
  at: string
  tz: string
  catch_up: 'once' | 'skip'
  mode: 'auto' | 'pane'
  pane_id: string
  pane_name: string
  agent: string
  /** '' = the CLI's default. */
  model: string
  effort: string
  token_budget: number
  max_runs_per_day: number
  max_fixes: number
  max_minutes: number
  scope: 'fix' | 'propose'
  extra: string
  ledger_plan: string
  /** Read-only (v1.1): a missed run is waiting for the workspace to open. */
  pending_catch_up?: boolean
}

export type EvolveRunStatus = 'running' | 'ok' | 'error' | 'timeout' | 'skipped'

export interface EvolveRun {
  id: string
  trigger: 'schedule' | 'manual' | 'catch_up'
  status: EvolveRunStatus
  reason?: string | null
  started_at: number
  ended_at?: number | null
  mode?: 'auto' | 'pane'
  pane_id?: string
  pane_name?: string
  agent?: string
  model?: string
  scope?: 'fix' | 'propose'
  template_version?: string | number
  tokens: number | null
  summary?: string
  commits: { hash: string; title: string }[]
  proposals: { rel_path: string; name: string }[]
  reclaimed: boolean | null
  detail?: string
}

export interface EvolveBadge {
  enabled: boolean
  running: boolean
  running_since: number | null
  next_run_at: number | null
  last_status: EvolveRunStatus | null
  /** v1.2: panes this workspace's recent runs used, newest first (incl. the
   *  running one). Optional so an older backend's badge still reads. */
  pane_ids?: readonly string[]
}

export interface EvolveState {
  workspace: string
  settings: EvolveSettings
  git: { is_repo: boolean; root: string; branch: string; subdir: string }
  job: { id: string; enabled: boolean; next_run_at: number | null } | null
  running: EvolveRun | null
  runs: EvolveRun[]
  legacy: { id: string; name: string; enabled: boolean }[]
  template: { version: string | number; text: string }
  /** evolve.set only: legacy jobs this call disabled. */
  disabled_legacy?: string[]
}

export type EvolveResult<T> = { ok: true; data: T } | { ok: false; error: string; reason?: string }

/** Badge bounds of the contract: `max_runs_per_day` etc. The panel validates
 *  against these before sending, the backend re-checks. */
export const EVOLVE_BOUNDS = {
  max_runs_per_day: [1, 10],
  max_fixes: [0, 10],
  max_minutes: [10, 600],
  extra: 4000,
} as const

const RPC_TIMEOUT_MS = 15_000

const badges = ref<Record<string, EvolveBadge>>({})
const panelWorkspace = ref<string | null>(null)
/** Pane ids evolve opened (a workspace's running.pane_id and runs[].pane_id),
 *  for the sidebar's 「✦ 系統開啟」 tag. Matched by id, never by pane name. */
const systemPaneIds = ref<ReadonlySet<string>>(new Set())
let boundBackend: Backend | null = null
/** Every path anyone asked a badge for, so a reconnect can re-read them. */
const knownPaths = new Set<string>()

export function openEvolvePanel(workspace: string): void {
  if (workspace) panelWorkspace.value = workspace
}

export function closeEvolvePanel(): void {
  panelWorkspace.value = null
}

function addSystemPanes(ids: readonly (string | null | undefined)[]): void {
  const fresh = ids.filter((id): id is string => !!id && !systemPaneIds.value.has(id))
  if (fresh.length) systemPaneIds.value = new Set([...systemPaneIds.value, ...fresh])
}

/** Record the panes named by an evolve.get / evolve.set reply. */
export function noteEvolvePanes(state: Pick<EvolveState, 'running' | 'runs'>): void {
  addSystemPanes([state.running?.pane_id, ...(state.runs ?? []).map((r) => r.pane_id)])
}

export function isEvolveSystemPane(paneId: string): boolean {
  return systemPaneIds.value.has(paneId)
}

function errorOf(resp: { ok: boolean; payload?: unknown; error?: { message?: string } | null }, type: string) {
  if (!resp.ok) return { error: resp.error?.message ?? `${type} failed`, reason: undefined }
  const body = resp.payload as { ok?: boolean; error?: string; reason?: string } | null | undefined
  if (!body || body.ok === false) return { error: body?.error ?? `${type} failed`, reason: body?.reason }
  return null
}

async function call<T>(backend: Backend, type: string, payload: Record<string, unknown>): Promise<EvolveResult<T>> {
  try {
    const resp = await backend.send<T & { ok?: boolean; error?: string; reason?: string }>(type, payload, RPC_TIMEOUT_MS)
    const err = errorOf(resp, type)
    if (err) return { ok: false, error: err.error, reason: err.reason }
    return { ok: true, data: resp.payload as T }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

export async function evolveGet(backend: Backend, workspace: string): Promise<EvolveResult<EvolveState>> {
  const res = await call<EvolveState>(backend, 'evolve.get', { workspace })
  if (res.ok) noteEvolvePanes(res.data)
  return res
}

export async function evolveSet(
  backend: Backend,
  workspace: string,
  settings: Partial<EvolveSettings>
): Promise<EvolveResult<EvolveState>> {
  const res = await call<EvolveState>(backend, 'evolve.set', { workspace, settings })
  if (res.ok) noteEvolvePanes(res.data)
  return res
}

export function evolveRunNow(backend: Backend, workspace: string): Promise<EvolveResult<{ run_id: string }>> {
  return call<{ run_id: string }>(backend, 'evolve.run_now', { workspace })
}

/** Store one badge (from a reply or a broadcast). */
export function setEvolveBadge(workspace: string, badge: EvolveBadge): void {
  if (!workspace || !badge) return
  badges.value = { ...badges.value, [workspace]: badge }
  addSystemPanes(badge.pane_ids ?? [])
}

/** Re-read the badges of these workspaces. A no-op until App.vue bound the
 *  backend, or while it is not connected. */
export async function refreshEvolveBadges(paths: string[]): Promise<void> {
  const list = [...new Set(paths.filter(Boolean))]
  for (const p of list) knownPaths.add(p)
  const backend = boundBackend
  if (!backend || list.length === 0 || backend.status.value !== 'connected') return
  const res = await call<{ badges?: Record<string, EvolveBadge> }>(backend, 'evolve.badges', { workspaces: list })
  if (!res.ok || !res.data.badges) return
  badges.value = { ...badges.value, ...res.data.badges }
  addSystemPanes(Object.values(res.data.badges).flatMap((b) => b.pane_ids ?? []))
}

export type EvolveBadgeState = 'on' | 'running' | 'off' | 'failed'

/** The heading badge's colour: running (blue) beats a failed last run (red,
 *  only while enabled), which beats enabled (green) and off (grey). */
export function evolveBadgeState(badge: EvolveBadge | null | undefined): EvolveBadgeState {
  if (!badge) return 'off'
  if (badge.running) return 'running'
  if (!badge.enabled) return 'off'
  if (badge.last_status === 'error' || badge.last_status === 'timeout') return 'failed'
  return 'on'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "09:00" today, "明天 09:00" tomorrow, "10-12 09:00" further out. */
export function formatEvolveNext(ms: number, now: number = Date.now()): string {
  const t = i18n.global.t
  const d = new Date(ms)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const today = new Date(now)
  if (sameDay(d, today)) return clock
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(d, tomorrow)) return t('evolve.badge.tomorrow', { time: clock })
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`
}

/** The heading badge's words. */
export function evolveBadgeLabel(badge: EvolveBadge | null | undefined, now: number = Date.now()): string {
  const t = i18n.global.t
  switch (evolveBadgeState(badge)) {
    case 'running': {
      const since = badge?.running_since
      const min = typeof since === 'number' ? Math.max(0, Math.floor((now - since) / 60_000)) : 0
      return t('evolve.badge.running', { min })
    }
    case 'failed':
      return t('evolve.badge.failed')
    case 'on':
      return typeof badge?.next_run_at === 'number' ? formatEvolveNext(badge.next_run_at, now) : t('evolve.badge.on')
    default:
      return t('evolve.badge.off')
  }
}

export function useEvolveBadges() {
  return {
    badges: readonly(badges),
    systemPaneIds: readonly(systemPaneIds),
    panelWorkspace: readonly(panelWorkspace),
    refreshBadges: refreshEvolveBadges,
    openPanel: openEvolvePanel,
    closePanel: closeEvolvePanel,
  }
}

const NOTICE_KINDS: readonly EvolveNoticeKind[] = [
  'started',
  'finished',
  'timeout',
  'failed',
  'skipped',
  'fallback_auto',
  'not_git',
  'over_budget',
]

/** App-level install: binds the backend and subscribes to the broadcasts.
 *  Call once, from App.vue. */
export function useEvolve(backend: Backend) {
  boundBackend = backend
  const announcements = useAnnouncements()
  const offs: (() => void)[] = []

  const offChanged = backend.on('evolve.changed', (raw) => {
    const ev = raw as { workspace?: string; badge?: EvolveBadge } | null
    if (ev?.workspace && ev.badge) setEvolveBadge(ev.workspace, ev.badge)
  })
  if (typeof offChanged === 'function') offs.push(offChanged)

  const offNotice = backend.on('evolve.notice', (raw) => {
    const ev = raw as Partial<EvolveNotice> | null
    if (!ev?.workspace || !ev.kind || !NOTICE_KINDS.includes(ev.kind)) return
    addSystemPanes([ev.run?.pane_id])
    announcements.noteEvolveNotice({ workspace: ev.workspace, kind: ev.kind, run: ev.run ?? null })
  })
  if (typeof offNotice === 'function') offs.push(offNotice)

  const stop = watch(
    () => backend.status.value,
    (status, previous) => {
      if (status === 'connected' && previous !== 'connected') void refreshEvolveBadges([...knownPaths])
    }
  )

  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const off of offs) off()
      stop()
      if (boundBackend === backend) boundBackend = null
    })
  }

  return useEvolveBadges()
}

/** Test-only: forget the module state. */
export function __resetEvolveForTest(): void {
  badges.value = {}
  panelWorkspace.value = null
  systemPaneIds.value = new Set()
  boundBackend = null
  knownPaths.clear()
}
