/**
 * Plan B watchdog option C (contract section 5.2): when a third-party backend
 * goes over a resource threshold the Host no longer stops it on its own; it
 * tells the user, who chooses to stop it or keep it running. Every step is
 * recorded: the notice (`notified`), and the user's `continue` or
 * `terminate`. The Host sends the rows to the backend over its authenticated
 * session; the backend stores them in `plugin_resource_decisions`. A failed
 * send is only logged: it never holds up the user's choice.
 *
 * No path or command line is recorded, only the measured item and numbers.
 */

/** Host → backend, Host-authenticated: `{rows: PluginResourceDecisionRow[]}`, answered `{ok, accepted}`. */
export const PLUGIN_RESOURCE_DECISION_MESSAGE = 'plugin.resource.decision'

/** What went over its threshold. `stdoutPending` (stdout a child sent without
 *  a newline yet, in bytes; review M2 on #375) is reserved: measured by the
 *  backend supervisor once DB9 (#375) lands, with the threshold DB9 sets. */
export type PluginResourceItem = 'memory' | 'cpu' | 'processes' | 'disk' | 'stdoutPending'
export type PluginResourceDecision = 'notified' | 'continue' | 'terminate'

export const PLUGIN_RESOURCE_ITEMS: readonly PluginResourceItem[] = ['memory', 'cpu', 'processes', 'disk', 'stdoutPending']
export const PLUGIN_RESOURCE_DECISIONS: readonly PluginResourceDecision[] = ['notified', 'continue', 'terminate']

/**
 * One row. Units by item: `memory`, `disk` and `stdoutPending` in bytes, `processes` a count,
 * `cpu` in cores (1.0 = one core, sustained for the CPU window; the window
 * does not change). `threshold` is the level this notice was raised at: the
 * default limit, or after a `continue` twice the larger of that level and the
 * usage then (contract 5.2).
 */
export interface PluginResourceDecisionRow {
  plugin_id: string
  plugin_version: string
  item: PluginResourceItem
  usage: number
  threshold: number
  decision: PluginResourceDecision
  /** Unix ms. */
  at: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** A row rebuilt from validated fields, or null (the backend applies the same rules). */
export function parsePluginResourceDecisionRow(value: unknown): PluginResourceDecisionRow | null {
  if (!isRecord(value)) return null
  const { plugin_id, plugin_version, item, usage, threshold, decision, at } = value
  if (
    typeof plugin_id !== 'string' || plugin_id.length === 0 || typeof plugin_version !== 'string' ||
    !(PLUGIN_RESOURCE_ITEMS as readonly unknown[]).includes(item) ||
    !(PLUGIN_RESOURCE_DECISIONS as readonly unknown[]).includes(decision) ||
    !nonNegative(usage) || !nonNegative(threshold) ||
    typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0
  ) return null
  return {
    plugin_id, plugin_version, item: item as PluginResourceItem, usage, threshold,
    decision: decision as PluginResourceDecision, at,
  }
}
