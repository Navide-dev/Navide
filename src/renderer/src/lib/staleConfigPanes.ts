import type { InjectionKey } from 'vue'

/** What a CLI loads once at start: its own MCP servers and its skills. */
export type StaleConfigPart = 'mcp' | 'skills'

/** One `terminal.config_status` row: a terminal whose inputs changed since spawn. */
export interface StaleConfigRow {
  terminal_session_id: string
  parts: StaleConfigPart[]
}

/** What the window remembers per pane: the terminal the answer was about,
 *  so a rebuilt pane (new terminal) stops showing the old answer at once. */
export interface StaleConfigEntry {
  terminalSessionId: string
  parts: StaleConfigPart[]
}

/** A stale pane as the MCP and Skills settings pages list it. */
export interface StaleConfigPane {
  id: string
  name: string
  parts: StaleConfigPart[]
  /** Mid-turn or starting: a rebuild would interrupt it, so "rebuild all idle" skips it. */
  busy: boolean
  canRebuild: boolean
}

export interface StaleConfigActions {
  panes: () => StaleConfigPane[]
  rebuild: (paneId: string) => void
  rebuildAllIdle: () => void
}

export const staleConfigKey: InjectionKey<StaleConfigActions> = Symbol('stale-config-panes')

/** Map a config_status answer back to pane ids. Terminals the answer does not
 *  name are not stale; rows for terminals the window no longer knows are dropped. */
export function staleEntriesFromStatus(
  paneBySession: ReadonlyMap<string, string>,
  rows: readonly StaleConfigRow[] | undefined,
): Record<string, StaleConfigEntry> {
  const next: Record<string, StaleConfigEntry> = {}
  for (const row of rows ?? []) {
    const paneId = paneBySession.get(row.terminal_session_id)
    if (paneId && row.parts.length) next[paneId] = { terminalSessionId: row.terminal_session_id, parts: [...row.parts] }
  }
  return next
}

/** The parts still stale for a pane right now, or none once it runs a different terminal. */
export function staleParts(
  entry: StaleConfigEntry | undefined,
  currentTerminalSessionId: string | undefined,
): StaleConfigPart[] {
  if (!entry || !currentTerminalSessionId || entry.terminalSessionId !== currentTerminalSessionId) return []
  return entry.parts
}

/** The panes "rebuild all idle" acts on: rebuildable and not mid-turn. */
export function idleRebuildable(panes: readonly StaleConfigPane[]): StaleConfigPane[] {
  return panes.filter((p) => p.canRebuild && !p.busy)
}
