// A Navide plugin command as the Host sees it, across the IPC boundary.

export interface PluginCommandEntry {
  commandId: string
  title: string
  pluginId: string
  pluginName: string
  suggestedKey?: string
}

/** Why a command did not run. A view the user has not opened stays closed: a
 *  keystroke never enables a plugin's view. */
export type PluginCommandFailure =
  | 'not-installed'
  | 'view-not-open'
  | 'view-not-openable'
  | 'method-failed'

export type PluginCommandRunResult =
  | { ok: true; /** The main stage tab the renderer should switch to. */ reveal?: string }
  | { ok: false; reason: PluginCommandFailure }

/** Host surfaces a plugin may put one of its own commands on (batch 4,
 *  view slots): the status bar, a pane's context menu, the Explorer's. */
export type PluginSlotKind = 'statusBar' | 'paneActions' | 'explorerMenu'

/** One command placed on a Host surface. `title` is plugin-written text and is
 *  always shown next to `pluginName`, so it cannot pass for a Navide control. */
export interface PluginSlotEntry {
  slot: PluginSlotKind
  pluginId: string
  pluginName: string
  commandId: string
  title: string
  tooltip?: string
  /** explorerMenu only: the entries it is offered on (default any). */
  when?: 'file' | 'directory' | 'any'
}

/** What a slot hands its command: the Explorer entry (workspace-relative
 *  path) or the pane it was used on. */
export interface PluginCommandTarget {
  path?: string
  paneId?: string
}

const TARGET_MAX_LENGTH = 4096

/** A target from the renderer, or null when it is anything else. */
export function parsePluginCommandTarget(value: unknown): PluginCommandTarget | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0 || keys.some((key) => key !== 'path' && key !== 'paneId')) return null
  const valid = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= TARGET_MAX_LENGTH
  if (record.path !== undefined && !valid(record.path)) return null
  if (record.paneId !== undefined && !valid(record.paneId)) return null
  return { ...(record.path !== undefined ? { path: record.path as string } : {}), ...(record.paneId !== undefined ? { paneId: record.paneId as string } : {}) }
}
