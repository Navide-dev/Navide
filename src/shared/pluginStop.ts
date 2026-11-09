/**
 * Plan P2 (plugin-comms-security): stopping one third-party Navide plugin at
 * once, from any of four places, and what was going on when it was stopped.
 *
 * A stop is the user's Disabled switch (or an agent's plugins_disable) plus a
 * record: where it came from and a summary of the plugin's activity at that
 * moment, shown before the plugin is enabled again. The disable itself is the
 * existing one: the Host settles every call in flight with PLUGIN_STOPPING,
 * stops its event routes, closes its views and stops its backend. Bundled
 * Navide plugins are never stopped this way.
 */

/** Where a stop came from: the Settings Activity monitor, the status bar's
 *  Navide plugins item, a chat command (`/plugins stop`), or an agent's
 *  `plugins_disable`. */
export type PluginStopVia = 'settings' | 'status-bar' | 'telegram' | 'mcp'

export const PLUGIN_STOP_VIAS: readonly PluginStopVia[] = ['settings', 'status-bar', 'telegram', 'mcp']

/** The plugin's activity when it was stopped. The activity counts are null
 *  when the backend could not be read in time (the stop never waits for it). */
export interface PluginStopSummary {
  /** Calls into its backend still running when it was stopped (settled with PLUGIN_STOPPING). */
  inFlightCalls: number
  toolCallsLastMinute: number | null
  capabilityCallsLastMinute: number | null
  consecutiveFailures: number | null
  /** Hosts its views reached that the manifest does not declare, or that were refused. */
  undeclaredHosts: string[]
}

export interface PluginStopRecord {
  /** Unix ms. */
  at: number
  via: PluginStopVia
  summary: PluginStopSummary
}

/** Backend → Host (Host session only): a chat command asks for the stoppable
 *  plugins (`status`) or to stop one (`stop`, with `plugin_id`). */
export const PLUGIN_STOP_REQUEST_EVENT = 'plugins.stop.request'
/** Host → backend: the answer, `{request_id, ok, ...}`. */
export const PLUGIN_STOP_RESULT_MESSAGE = 'plugins.stop.result'

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const countOrNull = (value: unknown): value is number | null => value === null || isCount(value)

/** A stop record rebuilt from checked fields, or null when anything is malformed. */
export function parsePluginStopRecord(value: unknown): PluginStopRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const summary = record.summary as Record<string, unknown> | null
  if (!isCount(record.at) || !PLUGIN_STOP_VIAS.includes(record.via as PluginStopVia)) return null
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return null
  const hosts = summary.undeclaredHosts
  if (
    !isCount(summary.inFlightCalls) || !countOrNull(summary.toolCallsLastMinute) ||
    !countOrNull(summary.capabilityCallsLastMinute) || !countOrNull(summary.consecutiveFailures) ||
    !Array.isArray(hosts) || !hosts.every((host) => typeof host === 'string')
  ) return null
  return {
    at: record.at,
    via: record.via as PluginStopVia,
    summary: {
      inFlightCalls: summary.inFlightCalls,
      toolCallsLastMinute: summary.toolCallsLastMinute,
      capabilityCallsLastMinute: summary.capabilityCallsLastMinute,
      consecutiveFailures: summary.consecutiveFailures,
      undeclaredHosts: [...hosts],
    },
  }
}
