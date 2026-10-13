/** Roll a run-group's per-pane statuses up into the single dot shown on its
 *  StageTabBar tab.
 *
 *  Three colours plus "nothing to report". The dot answers two questions, in
 *  this order: is anything here waiting on *you*, and failing that, is anything
 *  moving on its own? Waiting comes first because it is the only one of the two
 *  that stalls until a person acts — a tab where one pane holds a permission
 *  prompt while another runs is, for the person reading the bar, blocked.
 *
 *  Everything finer (error, disconnected, stopped) still lives in the pane
 *  badge and the agent overview; folding those in here would trade a glanceable
 *  signal for a legend nobody reads.
 *
 *  'starting' counts as active: it means the CLI is booting and about to move,
 *  so the seconds right after a spawn should not read as "nothing happening".
 */
import type { PaneStatusValue } from './paneStatusLabel'

export type TabRunState = 'awaiting' | 'active' | 'idle' | 'empty'

/** A pane that has stopped and will not move until someone answers it. Ranked
 *  above the active statuses, so one blocked pane is visible through a tab full
 *  of busy ones. Matches rollupPaneStatus's attention order, which puts
 *  awaiting first for the same reason. */
const AWAITING = 'awaiting'

/** Statuses that mean the pane is doing something on its own. Everything else
 *  — idle, stopped, exited, error, disconnected — means it will not move until
 *  someone acts. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'starting'])

/** Panes that exist in the list but have no terminal yet (cold-restore
 *  placeholders). A tab holding only these has nothing to report. */
const UNREALIZED = 'waiting'

export function rollupTabStatus(statuses: readonly string[]): TabRunState {
  let realized = false
  let active = false
  for (const status of statuses) {
    if (status === UNREALIZED) continue
    realized = true
    if (status === AWAITING) return 'awaiting'
    if (ACTIVE_STATUSES.has(status)) active = true
  }
  if (active) return 'active'
  return realized ? 'idle' : 'empty'
}

/** The pane status a rolled-up tab state is painted as.
 *
 *  The dot's own vocabulary is coarser than a pane status (see TabRunState),
 *  but its colours have always been the pane colours for the statuses it
 *  stands in for — so when the user recolours a status in Settings, the dot
 *  has to move with it rather than keeping the shipped hue. 'empty' maps to
 *  nothing: it is the absence of a signal, not a status.
 */
export function tabRunStatePaneStatus(state: TabRunState): PaneStatusValue | null {
  if (state === 'awaiting') return 'awaiting'
  // 'starting' also rolls up to active, but 'running' is what the dot has
  // always been painted as, and it is the one a user recolours to mean "busy".
  if (state === 'active') return 'running'
  if (state === 'idle') return 'idle'
  return null
}

/** i18n key for what a group's rolled-up dot is saying. Kept as a key, like
 *  paneStatusLabelKey, so each caller resolves it in its own $t scope.
 *
 *  The dot was the one thing on a group row with no words attached to it:
 *  colours and nothing anywhere that said what they meant. */
export function runGroupStateLabelKey(state: TabRunState): string {
  return `label.run-group-${state}`
}

/** How many of a tab's panes are live — the "live" of the "live / total" the
 *  sidebar's workspace heading shows. A cold-restored or reclaimed placeholder
 *  holds no process and is the only pane whose status is 'waiting', so
 *  everything else counts. */
export function countLivePanes(statuses: readonly string[]): number {
  return statuses.filter((s) => s !== 'waiting').length
}

/** The fields a rendered tab is made of. Structural typing keeps this file free
 *  of a Vue import — StageTabBar's TabItem satisfies it. */
interface RenderedTab {
  key: string
  label: string
  count: number
  live: number
  status: TabRunState
}

/** True when two tab lists would render identically.
 *
 *  The status dot is recomputed every 400 ms with the pane-status snapshot, and
 *  nearly every one of those ticks reports the same thing. Returning the
 *  previous array when nothing changed keeps the tab bar — which is always on
 *  screen — from re-rendering 2.5 times a second for no visible difference. */
export function sameRenderedTabs(a: readonly RenderedTab[], b: readonly RenderedTab[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].key !== b[i].key ||
      a[i].label !== b[i].label ||
      a[i].count !== b[i].count ||
      a[i].live !== b[i].live ||
      a[i].status !== b[i].status
    ) {
      return false
    }
  }
  return true
}
