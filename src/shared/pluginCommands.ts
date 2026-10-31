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
  | 'method-unavailable'

export type PluginCommandRunResult =
  | { ok: true; /** The main stage tab the renderer should switch to. */ reveal?: string }
  | { ok: false; reason: PluginCommandFailure }
