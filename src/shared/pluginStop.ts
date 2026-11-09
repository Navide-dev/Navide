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
export type PluginStopVia = 'settings' | 'status-bar' | 'telegram' | 'mcp' | 'auto'

/** `auto` (plan P5): Navide paused the plugin on one of its anomaly rules. */
export const PLUGIN_STOP_VIAS: readonly PluginStopVia[] = ['settings', 'status-bar', 'telegram', 'mcp', 'auto']

/** Plan P5's anomaly rules (section 4.2): R1 frequency, R2 an undeclared or
 *  refused network host, R3 failures in a row or restarts, R4 a resource over
 *  its threshold, R5 too many notifications. */
export type PluginAutoPauseRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'
export const PLUGIN_AUTO_PAUSE_RULES: readonly PluginAutoPauseRule[] = ['R1', 'R2', 'R3', 'R4', 'R5']

/** The fixed thresholds of 0.2.40 (the user's decision of 11-08): disclosed
 *  in Settings; one switch turns automatic pauses off. */
export const PLUGIN_AUTO_PAUSE_THRESHOLDS = Object.freeze({
  toolCallsPerMinute: 60,
  capabilityCallsPerMinute: 600,
  consecutiveFailures: 10,
  restartsInTenMinutes: 3,
  notificationsPerMinute: 6,
})

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
  /** `via: 'auto'` only: the rule that paused it. */
  rule?: PluginAutoPauseRule
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
  if (record.rule !== undefined && !PLUGIN_AUTO_PAUSE_RULES.includes(record.rule as PluginAutoPauseRule)) return null
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
    ...(record.rule !== undefined ? { rule: record.rule as PluginAutoPauseRule } : {}),
  }
}

/** Host → backend (plan P5): `{plugin_id, plugin_version, rule, value, threshold, detail}`. */
export const PLUGIN_AUTO_PAUSED_MESSAGE = 'plugins.auto_paused'

/** What the main window is told when a plugin was paused on its own. */
export interface PluginAutoPauseNotice {
  pluginId: string
  rule: PluginAutoPauseRule
  value: number
  threshold: number
  detail: string
}

// ── Plan P3: every third-party plugin at once ──

/** The third-party switches a global stop turns off, as they were before it:
 *  native backends, agents calling third-party tools (DB8) and external MCP
 *  clients calling them (DB4). "Resume all" puts them back. */
export interface PluginGlobalStopSwitches {
  nativeBackends: boolean
  agentTools: boolean
  externalCallers: boolean
}

/** A global stop in effect: kept on disk until the user resumes, so the
 *  status bar still shows it after a restart. */
export interface PluginGlobalStopRecord {
  at: number
  via: PluginStopVia
  /** Who asked: the user (Settings, status bar, a chat) or an agent (MCP). */
  by: 'user' | 'agent'
  /** The plugins this stop disabled; "Resume all" enables these again. */
  stopped: string[]
  previous: PluginGlobalStopSwitches
}

/** A global stop record rebuilt from checked fields, or null when malformed. */
export function parsePluginGlobalStopRecord(value: unknown): PluginGlobalStopRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const previous = record.previous as Record<string, unknown> | null
  if (!isCount(record.at) || !PLUGIN_STOP_VIAS.includes(record.via as PluginStopVia)) return null
  if (record.by !== 'user' && record.by !== 'agent') return null
  if (!Array.isArray(record.stopped) || !record.stopped.every((id) => typeof id === 'string')) return null
  if (typeof previous !== 'object' || previous === null || Array.isArray(previous)) return null
  if (typeof previous.nativeBackends !== 'boolean' || typeof previous.agentTools !== 'boolean' ||
    typeof previous.externalCallers !== 'boolean') return null
  return {
    at: record.at,
    via: record.via as PluginStopVia,
    by: record.by,
    stopped: [...record.stopped as string[]],
    previous: { nativeBackends: previous.nativeBackends, agentTools: previous.agentTools, externalCallers: previous.externalCallers },
  }
}
