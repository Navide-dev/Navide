/** Builds persona mode's rooms from the stage's own structures: one room per
 *  stage tab (run group), people in tab order, statuses as the tab bar reads
 *  them. Pure — App passes accessors for the live per-pane bits. */
import { RAIL_PALETTE } from '../workspaceRails'
import type { PaneStatusValue } from '../paneStatusLabel'
import type { PersonaPerson, PersonaRoom } from './personaModel'
import type { QuotaStage } from './sprites'

export interface PersonaTabShape {
  key: string
  label: string
  paneIds: readonly string[]
}

export interface PersonaPaneFacts {
  name: string
  vendor: string
  agentColor?: string | null
  quota?: QuotaStage
  loginExpired?: boolean
  guarded?: boolean
  /** A start time the pane itself knows for its current status, if any. */
  since?: number
}

/** First-seen time of each pane's current status, so a status that carries no
 *  clock of its own still shows how long it has lasted. Owned by the caller,
 *  one per view, and pruned of panes that are gone. */
export type StatusClock = Map<string, { status: PaneStatusValue; since: number }>

export function buildPersonaRooms(input: {
  tabs: readonly PersonaTabShape[]
  /** All pane ids on stage, for the single room shown when there are no tabs. */
  stagePaneIds: readonly string[]
  fallbackLabel: string
  statusOf: (id: string) => PaneStatusValue
  factsOf: (id: string) => PersonaPaneFacts | null
  clock: StatusClock
  now: number
}): PersonaRoom[] {
  const tabs = input.tabs.length
    ? input.tabs
    : [{ key: 'manual', label: input.fallbackLabel, paneIds: input.stagePaneIds }]
  const seen = new Set<string>()
  const rooms = tabs.map((tab, i) => {
    const people: PersonaPerson[] = []
    for (const id of tab.paneIds) {
      const facts = input.factsOf(id)
      if (!facts) continue
      seen.add(id)
      const status = input.statusOf(id)
      const prev = input.clock.get(id)
      if (!prev || prev.status !== status) input.clock.set(id, { status, since: input.now })
      people.push({
        id,
        name: facts.name,
        status,
        vendor: facts.vendor,
        agentColor: facts.agentColor ?? null,
        quota: facts.quota ?? null,
        loginExpired: !!facts.loginExpired,
        guarded: !!facts.guarded,
        since: facts.since && facts.since > 0 ? facts.since : input.clock.get(id)!.since,
      })
    }
    return { key: tab.key, label: tab.label, color: RAIL_PALETTE[i % RAIL_PALETTE.length], people }
  })
  for (const id of [...input.clock.keys()]) if (!seen.has(id)) input.clock.delete(id)
  return rooms
}

/** The quota stage a pane's usage badge shows: useUsage's remainingTier
 *  ('warn' ≤ 40 %, 'crit' < 15 %), with a hit limit or exhausted reading as empty. */
export function quotaStage(tier: 'ok' | 'warn' | 'crit' | null, exhausted: boolean): QuotaStage {
  if (exhausted) return 'empty'
  if (tier === 'crit') return 'critical'
  if (tier === 'warn') return 'low'
  return null
}
