import { paneKey, paneState, type DesktopRoster } from '../../types/pane.ts'

export type PaneEventKind = 'done' | 'approval' | 'question'

export interface PaneEvent {
  id: string
  kind: PaneEventKind
  deviceName: string
  paneName: string
  workspace: string
  at: number
}

/**
 * Turns two consecutive roster snapshots into in-app notifications:
 * a pane that went from busy to idle finished its turn, and a pane that
 * started waiting on the user needs an approval or an answer. The first
 * snapshot after connecting produces nothing, so reconnecting never replays
 * old events.
 */
export function diffRosters(
  prev: DesktopRoster[] | null,
  next: DesktopRoster[],
  now: number = Date.now(),
): PaneEvent[] {
  if (prev === null) return []
  const before = new Map<string, ReturnType<typeof paneState>>()
  for (const d of prev) for (const p of d.panes) before.set(paneKey(d.deviceId, p), paneState(p))

  const events: PaneEvent[] = []
  for (const d of next) {
    for (const p of d.panes) {
      const key = paneKey(d.deviceId, p)
      const was = before.get(key)
      if (was === undefined) continue
      const is = paneState(p)
      let kind: PaneEventKind | null = null
      if (is === 'attention' && was !== 'attention') {
        kind = p.awaitingKind === 'question' ? 'question' : 'approval'
      } else if (was === 'busy' && is === 'idle') {
        kind = 'done'
      }
      if (kind) {
        events.push({
          id: `${key}\u0000${now}\u0000${kind}`,
          kind,
          deviceName: d.deviceName,
          paneName: p.name,
          workspace: p.workspace,
          at: now,
        })
      }
    }
  }
  return events
}
