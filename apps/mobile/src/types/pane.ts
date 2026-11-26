/**
 * The pane summary a paired phone receives. These five fields are the whole
 * contract: the app must not depend on anything else a roster frame carries.
 */
export type AwaitingKind = 'permission' | 'question'

export interface PaneSummary {
  /** The pane's name as shown in the desktop sidebar. */
  name: string
  /** Which CLI runs in the pane (e.g. "claude", "codex"). */
  agentKey: string
  /** The desktop's own status word for the pane. */
  status: string
  /** Set while the pane is waiting on the user. */
  awaitingKind: AwaitingKind | null
  /** The workspace folder name (never the full path). */
  workspace: string
}

export interface DesktopRoster {
  deviceId: string
  deviceName: string
  panes: PaneSummary[]
}

/** How the app groups the desktop's many status words. */
export type PaneState = 'busy' | 'attention' | 'idle' | 'offline'

const BUSY = new Set(['running', 'starting'])
const OFFLINE = new Set(['disconnected', 'exited', 'stopped', 'error'])

export function paneState(pane: PaneSummary): PaneState {
  if (pane.awaitingKind || pane.status === 'awaiting') return 'attention'
  if (BUSY.has(pane.status)) return 'busy'
  if (OFFLINE.has(pane.status)) return 'offline'
  return 'idle'
}

/** Identity of a pane within one desktop. Panes carry no id on the wire. */
export function paneKey(deviceId: string, pane: PaneSummary): string {
  return `${deviceId}\u0000${pane.workspace}\u0000${pane.name}`
}

/** Keeps exactly the five contract fields, dropping anything else. */
export function pickPaneSummary(raw: unknown): PaneSummary | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.name !== 'string' || typeof r.status !== 'string') return null
  const kind = r.awaitingKind
  return {
    name: r.name,
    agentKey: typeof r.agentKey === 'string' ? r.agentKey : '',
    status: r.status,
    awaitingKind: kind === 'permission' || kind === 'question' ? kind : null,
    workspace: typeof r.workspace === 'string' ? r.workspace : '',
  }
}
