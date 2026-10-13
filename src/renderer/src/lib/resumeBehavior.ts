// User preference for what happens to previously spawned CLI panes when a
// workspace opens: resume their prior conversations ('always'), start fresh
// ones ('never'), or show a confirmation dialog ('ask'). Pure decision logic —
// App.vue supplies the setting value, the per-window decision cache, and the
// confirm-dialog `ask`.

export type ResumeBehavior = 'always' | 'never' | 'ask'
export type RestoreScope = 'single' | 'page' | 'tab' | 'all'

/** Settings-store key (ui_settings.json via lib/settings.ts). */
export const RESUME_BEHAVIOR_SETTING_KEY = 'agentTeam.resumeBehavior'
export const RESTORE_SCOPE_SETTING_KEY = 'agentTeam.restoreScope'
/** Whether a pane whose PTY died with the backend is resumed automatically
 *  once the backend comes back. */
export const AUTO_RESUME_ON_RECONNECT_SETTING_KEY = 'agentTeam.autoResumeOnReconnect'

/**
 * Guard for the auto-resume-on-reconnect setting. Default ON, so the point of
 * the setting is to turn the automation off.
 *
 * Deliberately NOT folded into `resumeBehavior`. That preference governs
 * opening a workspace, where 'ask' is reasonable: the user has just arrived and
 * is choosing what to bring back. This one governs a backend crash that
 * interrupted work already under way — the pane was already open, already
 * resumed once, and the user did not ask for any of it to stop. Asking again
 * there only puts a dialog between them and the work they were doing.
 */
export function normalizeAutoResumeOnReconnect(v: unknown): boolean {
  return v !== false
}

/** Whether a manual relaunch brings back, by itself, the panes that were
 *  working when the app closed (and the parents waiting on them). */
export const RESUME_INTERRUPTED_ON_LAUNCH_SETTING_KEY = 'agentTeam.resumeInterruptedOnLaunch'

/** At most this many interrupted panes (parents included) come back on their
 *  own after a relaunch; the rest stay placeholders, marked. Each CLI costs
 *  real memory the moment it starts. */
export const INTERRUPTED_RESUME_LIMIT = 6

/** Guard for the resume-interrupted-on-launch setting. Default ON.
 *
 *  Not folded into autoResumeOnReconnect: that one answers a backend crash
 *  inside a running app; this one answers a relaunch the user chose to do. */
export function normalizeResumeInterruptedOnLaunch(v: unknown): boolean {
  return v !== false
}

/** The persisted turn state for a pane's badge word. A running turn and a pane
 *  parked on a permission box or a question ('awaiting') are both work the
 *  relaunch interrupted. Null for every state that says nothing about a turn —
 *  a placeholder (''), a booting CLI, a dead one — so nothing is written and
 *  the last real state stands. */
export function turnStateForStatus(status: string): 'working' | 'idle' | null {
  if (status === 'running' || status === 'awaiting') return 'working'
  if (status === 'idle') return 'idle'
  return null
}

/** Whether a saved pane was interrupted by the app closing: it was working, or
 *  it still owed its parent a report — its first turn never ended, even if it
 *  went quiet long enough for the badge to read idle. */
export function wasInterruptedAtLaunch(saved: {
  last_turn_state?: string
  report_pending?: boolean
}): boolean {
  return saved.last_turn_state === 'working' || saved.report_pending === true
}

/** Pick the placeholders a relaunch resumes by itself: interrupted panes,
 *  visible ones first, each followed by its parent when that parent is also
 *  still a placeholder (it is the one waiting on the report). Stops at `limit`,
 *  parents counted. */
export function interruptedRestoreTargetIds(opts: {
  pending: readonly { id: string; interrupted: boolean; spawnedBy?: string }[]
  visibleIds: readonly string[]
  limit: number
}): string[] {
  const pendingIds = new Set(opts.pending.map((p) => p.id))
  const visible = new Set(opts.visibleIds)
  const interrupted = opts.pending.filter((p) => p.interrupted)
  const ordered = [
    ...interrupted.filter((p) => visible.has(p.id)),
    ...interrupted.filter((p) => !visible.has(p.id)),
  ]
  const out: string[] = []
  const add = (id: string): void => {
    if (out.length < opts.limit && !out.includes(id)) out.push(id)
  }
  for (const p of ordered) {
    add(p.id)
    if (p.spawnedBy && pendingIds.has(p.spawnedBy)) add(p.spawnedBy)
  }
  return out
}

/** Guard for values read from the settings store: anything but a known
 *  behavior falls back to 'always' (the pre-preference behavior). */
export function normalizeResumeBehavior(v: unknown): ResumeBehavior {
  return v === 'never' || v === 'ask' ? v : 'always'
}

/** Scope for an automatic resume. Old installs safely restore one CLI only. */
export function normalizeRestoreScope(v: unknown): RestoreScope {
  return v === 'page' || v === 'tab' || v === 'all' ? v : 'single'
}

export type RestoreDecision = 'resume' | 'fresh'
export type RestoreSessionDecision = RestoreDecision | 'cancelled'
export type RestoreSessionTrigger = 'cold' | 'tab' | 'layout' | 'grid-page'

/** One cold-open decision snapshot. Settings are read only when this session is
 * created; a workspace re-check reuses it, while opening another workspace
 * creates a new snapshot. */
export interface WorkspaceRestoreSession {
  workspacePath: string
  behavior: ResumeBehavior
  scope: RestoreScope
  decision?: RestoreSessionDecision
}

export function createWorkspaceRestoreSession(opts: {
  workspacePath: string
  behavior: unknown
  scope: unknown
}): WorkspaceRestoreSession {
  return {
    workspacePath: opts.workspacePath,
    behavior: normalizeResumeBehavior(opts.behavior),
    scope: normalizeRestoreScope(opts.scope),
  }
}

export function settleWorkspaceRestoreSession(
  session: WorkspaceRestoreSession,
  decision: RestoreSessionDecision,
  scope?: RestoreScope,
): RestoreSessionDecision {
  session.decision = decision
  if (decision === 'resume' && scope) session.scope = scope
  return decision
}

/** Return unrealized deferred panes for one workspace. Deferred metadata is
 * the stable marker that a persisted pane is still awaiting cold restore. */
export function pendingRestorePaneIds(
  panes: readonly {
    id: string
    workspacePath: string
    realized?: boolean
    deferredRestore?: unknown
  }[],
  workspacePath: string,
): string[] {
  return panes
    .filter((pane) =>
      pane.workspacePath === workspacePath &&
      !pane.realized &&
      pane.deferredRestore != null
    )
    .map((pane) => pane.id)
}

/** Pick pending, non-minimized pane ids for one automatic restore scope.
 * App.vue supplies the already-tab-filtered and Grid-page-filtered order. */
export function restoreScopeTargetIds(opts: {
  scope: RestoreScope
  pendingPaneIds: readonly string[]
  activeTabPaneIds: readonly string[]
  gridPagePaneIds: readonly string[]
  minimizedPaneIds: ReadonlySet<string>
  focusedPaneId?: string | null
  trigger?: RestoreSessionTrigger
}): string[] {
  const pending = new Set(opts.pendingPaneIds)
  const eligible = (ids: readonly string[]): string[] => ids.filter(
    (id) => pending.has(id) && !opts.minimizedPaneIds.has(id)
  )
  const activeTab = eligible(opts.activeTabPaneIds)
  if (opts.scope === 'single') {
    const candidates = opts.trigger === 'grid-page' ? eligible(opts.gridPagePaneIds) : activeTab
    const focused = candidates.find((id) => id === opts.focusedPaneId)
    return (focused ? [focused] : candidates.slice(0, 1))
  }
  if (opts.scope === 'page') return eligible(opts.gridPagePaneIds)
  if (opts.scope === 'all') {
    // Visible panes first so the user sees progress in the active tab.
    const rest = eligible(opts.pendingPaneIds).filter((id) => !activeTab.includes(id))
    return [...activeTab, ...rest]
  }
  return activeTab
}

/** An 'all' restore starts at most this many panes at once; each next pane
 *  waits for a prior spawn to complete (backend spawn ack). */
export const ALL_SCOPE_RESTORE_CONCURRENCY = 2

/** Run task over ids with a fixed worker count, preserving start order. */
export async function runWithConcurrency(
  ids: readonly string[],
  limit: number,
  task: (id: string) => Promise<unknown>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next]
      next += 1
      await task(id)
    }
  }
  const workers = Math.max(1, Math.min(limit, ids.length))
  await Promise.all(Array.from({ length: workers }, () => worker()))
}

/** Remove a hand-written `--session-id <uuid>` (or `--session-id=<uuid>`) from a
 *  saved custom command. Used only on the start-fresh path: that id's transcript
 *  still exists, so keeping it baked into the command would make the "fresh" pane
 *  resume (and re-persist) the old conversation instead of minting a new id.
 *  Leaves any other command untouched. */
export function stripPinnedSessionId(command: string): string {
  return command.replace(/\s*--session-id[=\s]+\S+/g, '').trim()
}

/** Drop `--auto` from a saved opencode command.
 *
 *  Navide declared `--auto` as opencode's YOLO flag for a while, so panes
 *  created in that window persisted `opencode --auto …`. The opencode root
 *  command has no such flag and rejects it — it prints its help banner and
 *  exits 1 — so those saved commands make the pane die the moment it spawns,
 *  every restore, until the command is rewritten. Spawning rebuilds the flag
 *  from the vendor spec, so removing it here is safe and only ever removes a
 *  flag that could not have run. Scoped to opencode: its fork `kilo` really
 *  does take `--auto` on the root command.
 */
export function stripDeadOpencodeAutoFlag(agentKey: string, command: string): string {
  if (agentKey !== 'opencode' || !command) return command
  return command.replace(/\s+--auto(?=\s|$)/g, '').trim()
}

/** Resolve and persist the one decision for a workspace cold-open session.
 * A cancelled automatic restore stays cancelled until an explicit pane click
 * asks again. */
export async function resolveWorkspaceRestoreSession(opts: {
  session: WorkspaceRestoreSession
  restorableCount: number
  retryCancelled?: boolean
  ask: () => Promise<RestoreScope | 'fresh' | null>
}): Promise<RestoreSessionDecision> {
  if (opts.session.decision === 'cancelled' && !opts.retryCancelled) return 'cancelled'
  if (opts.session.decision && opts.session.decision !== 'cancelled') return opts.session.decision
  if (opts.session.behavior === 'always' || opts.restorableCount === 0) {
    return settleWorkspaceRestoreSession(opts.session, 'resume')
  }
  if (opts.session.behavior === 'never') {
    return settleWorkspaceRestoreSession(opts.session, 'fresh')
  }
  const selection = await opts.ask()
  if (selection === null) return settleWorkspaceRestoreSession(opts.session, 'cancelled')
  if (selection === 'fresh') return settleWorkspaceRestoreSession(opts.session, 'fresh')
  return settleWorkspaceRestoreSession(opts.session, 'resume', selection)
}

/** The decision for a restore an agent asked for BY NAME — one pane, through
 *  ui.pane.open — as opposed to the workspace-wide question the modal asks.
 *  Naming the pane already answers "which ones", so `ask` collapses to a
 *  single-pane resume without the modal. Deliberately does NOT settle the
 *  session: the user's own next click on a different placeholder is still
 *  asked, exactly as before. A decision the user already made stands, and so
 *  does `never`: an agent's request is not a licence to resume a conversation
 *  the user said should never be resumed — it opens fresh, as their click
 *  would have. */
export function explicitRestoreDecision(session: WorkspaceRestoreSession): RestoreSessionDecision {
  if (session.decision === 'resume' || session.decision === 'fresh') return session.decision
  return session.behavior === 'never' ? 'fresh' : 'resume'
}
