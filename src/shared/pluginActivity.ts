/**
 * Plan B D-f: what the activity page and the disclosure overview read
 * (contract section 5.1). The backend (D-e) answers `plugins.activity.report`,
 * which only the Host's authenticated session may send (the renderer asks the
 * Host over IPC), from `plugin_tool_calls`, `plugin_activity`,
 * `plugin_activity_daily` and, once B2-c lands, `plugin_agent_actions`; it
 * does the aggregation and the anomaly checks. The renderer only shows the
 * answer, after rebuilding it from validated fields (`parsePluginActivityReport`).
 *
 * Everything in a report is a record of what happened; it decides nothing.
 * Every string is shown as plain text, never as a link or HTML.
 */

export const PLUGIN_ACTIVITY_REPORT_SCHEMA_VERSION = 1

/** `args_bytes` / `result_bytes` of a call whose size is not known. Never
 *  summed, never averaged; the page shows "unknown". */
export const UNKNOWN_BYTES = -1

export type PluginActivitySource = 'broker' | 'shell' | 'agentTool'
export type PluginActivityOutcome = 'allowed' | 'denied' | 'error'
export type PluginToolCallerKind = 'pane' | 'external' | 'host'

/** One row of `plugin_tool_calls` (newest first). */
export interface PluginActivityToolCall {
  id: number
  at: number
  callerKind: PluginToolCallerKind
  paneId: string
  paneName: string
  callerWorkspace: string
  targetWorkspace: string
  crossWorkspace: boolean
  pluginVersion: string
  tool: string
  risk: 'read' | 'write'
  outcome: 'ok' | 'error'
  errorCode: string
  durationMs: number
  /** UNKNOWN_BYTES (-1) when not known. */
  argsBytes: number
  /** UNKNOWN_BYTES (-1) when not known; 0 when the call had no result. */
  resultBytes: number
}

/** A workspace-relative path the plugin read or wrote (fs), newest first. */
export interface PluginActivityFile {
  path: string
  address: string
  workspace: string
  outcome: PluginActivityOutcome
  count: number
  lastAt: number
}

/** A command the plugin ran: executable and subcommand only, newest first. */
export interface PluginActivityCommand {
  command: string
  workspace: string
  outcome: PluginActivityOutcome
  count: number
  lastAt: number
}

/** One UTC day of `plugin_activity_daily`, oldest first. */
export interface PluginActivityDay {
  day: string
  calls: number
  denied: number
  errors: number
}

/** A declared permission or tool with no call in the last 30 days ("never used"). */
export interface PluginActivityDeclaredUnused {
  kind: 'system' | 'shell' | 'backendMethod' | 'agentTool'
  key: string
  /** Last call ever recorded (within the 90-day daily rows), or null. */
  lastUsedAt: number | null
}

/** A use the manifest did not declare, refused by the Host (red on the
 *  page). Covers the last 30 days (`undeclaredSince`): detail rows for 7 days,
 *  a daily table for the rest, which keeps the reasons. */
export interface PluginActivityUndeclared {
  source: PluginActivitySource
  address: string
  workspace: string
  count: number
  lastAt: number
  /** How the refusals split by `denied_reason`, largest first. */
  reasons: Array<{ reason: string; count: number }>
}

export type PluginActivityAnomalyKind = 'volumeSpike' | 'writeToolNewWorkspace' | 'undeclaredDenied'

/** Marked only, never acted on (D3). */
export interface PluginActivityAnomaly {
  kind: PluginActivityAnomalyKind
  at: number
  workspace: string
  /** writeToolNewWorkspace: the tool. */
  tool: string | null
  /** volumeSpike: calls on that day; undeclaredDenied: refusals. */
  count: number | null
  /** volumeSpike: the 7-day daily average it is compared against. */
  baseline: number | null
}

/** One row of B2-c's `plugin_agent_actions`: an agent changed this plugin. */
export interface PluginAgentAction {
  at: number
  action: string
  callerKind: PluginToolCallerKind
  paneId: string
  paneName: string
  workspace: string
  version: string
}

export interface PluginActivityReport {
  schemaVersion: typeof PLUGIN_ACTIVITY_REPORT_SCHEMA_VERSION
  pluginId: string
  generatedAt: number
  /** The detail window the lists cover (7 days of detail rows). */
  window: { from: number; to: number }
  totals: { calls: number; denied: number; errors: number }
  /** Historical: the largest number of this plugin's calls that overlapped
   *  in time within `window`, from the recorded call intervals. The current
   *  number in flight is not in a report (running calls are not recorded yet):
   *  the page reads it live from `plugins:backendCallConcurrency` (#363). */
  historicalPeakConcurrency: number
  /** Start of the window `undeclared` covers (30 days). */
  undeclaredSince: number
  toolCalls: PluginActivityToolCall[]
  files: PluginActivityFile[]
  commands: PluginActivityCommand[]
  daily: PluginActivityDay[]
  declaredUnused: PluginActivityDeclaredUnused[]
  undeclared: PluginActivityUndeclared[]
  anomalies: PluginActivityAnomaly[]
  /** null until B2-c's `plugin_agent_actions` exists. */
  agentActions: PluginAgentAction[] | null
  /** Calls into the plugin's own backend (any path), counted per minute; not in
   *  `totals`, `daily` or `volumeSpike`. */
  backendCalls: PluginActivityBackendCalls
}

export type PluginBackendCallOutcome = 'allowed' | 'denied' | 'cancelled' | 'error'

/** The one address every call of a method the plugin's backend does not
 *  declare is counted under (contract 5): such names are the caller's free
 *  text, with no length or variety limit, so they are never keys. A report
 *  shows them as "called undeclared methods N times". */
export const BACKEND_CALL_UNDECLARED_ADDRESS = 'backend.<undeclared>'

export interface PluginActivityBackendCalls {
  /** Per `backend.<method>` address and outcome, from the UTC day `window`
   *  starts in; calls of undeclared methods are all under
   *  BACKEND_CALL_UNDECLARED_ADDRESS. */
  methods: Array<{ address: string; outcome: PluginBackendCallOutcome; count: number; lastAt: number }>
  /** Per UTC day still kept. */
  daily: Array<{ day: string; calls: number; denied: number; errors: number; cancelled: number }>
}

/** `plugins.activity.report` request: one plugin's report. The Host sends it
 *  over its authenticated session and fills `declared` from the installed
 *  manifest (the backend has no third-party manifest); without `declared`,
 *  `declaredUnused` is `[]`. */
export interface PluginActivityReportRequest {
  plugin_id: string
  declared?: Array<{ kind: PluginActivityDeclaredUnused['kind']; key: string }>
  /** When the Host installed this package (Unix ms): `writeToolNewWorkspace`
   *  counts only writes since then, so a reinstall is new again even if the
   *  removal's `plugin.activity.forget` was lost. */
  installedAt?: number
}

/** Sum of the known sizes; unknown (-1) ones are counted, never added. */
export function sumKnownBytes(values: readonly number[]): { bytes: number; unknown: number } {
  let bytes = 0
  let unknown = 0
  for (const value of values) {
    if (value === UNKNOWN_BYTES) unknown += 1
    else bytes += value
  }
  return { bytes, unknown }
}

/** A size, or null when it is unknown. */
export function knownBytes(value: number): number | null {
  return value === UNKNOWN_BYTES ? null : value
}

// ── Validation: the renderer rebuilds a report from checked fields only ──

type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isTime = isCount
const isSize = (value: unknown): value is number => value === UNKNOWN_BYTES || isCount(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
const nullable = <T>(value: unknown, check: (v: unknown) => v is T): value is T | null => value === null || check(value)

const SOURCES: readonly PluginActivitySource[] = ['broker', 'shell', 'agentTool']
const OUTCOMES: readonly PluginActivityOutcome[] = ['allowed', 'denied', 'error']
const CALLER_KINDS: readonly PluginToolCallerKind[] = ['pane', 'external', 'host']
const UNUSED_KINDS: readonly PluginActivityDeclaredUnused['kind'][] = ['system', 'shell', 'backendMethod', 'agentTool']
const ANOMALY_KINDS: readonly PluginActivityAnomalyKind[] = ['volumeSpike', 'writeToolNewWorkspace', 'undeclaredDenied']

/** Each entry rebuilt by `build`; null when the value is not an array or any entry is malformed. */
function list<T>(value: unknown, build: (entry: Rec) => T | null): T[] | null {
  if (!Array.isArray(value)) return null
  const out: T[] = []
  for (const entry of value) {
    const built = isRec(entry) ? build(entry) : null
    if (built === null) return null
    out.push(built)
  }
  return out
}

function toolCall(e: Rec): PluginActivityToolCall | null {
  if (
    !isCount(e.id) || !isTime(e.at) || !oneOf(CALLER_KINDS, e.callerKind) || !isText(e.paneId) ||
    !isText(e.paneName) || !isText(e.callerWorkspace) || !isText(e.targetWorkspace) ||
    typeof e.crossWorkspace !== 'boolean' || !isText(e.pluginVersion) || !isText(e.tool) ||
    !oneOf(['read', 'write'] as const, e.risk) || !oneOf(['ok', 'error'] as const, e.outcome) ||
    !isText(e.errorCode) || !isCount(e.durationMs) || !isSize(e.argsBytes) || !isSize(e.resultBytes)
  ) return null
  return {
    id: e.id, at: e.at, callerKind: e.callerKind, paneId: e.paneId, paneName: e.paneName,
    callerWorkspace: e.callerWorkspace, targetWorkspace: e.targetWorkspace, crossWorkspace: e.crossWorkspace,
    pluginVersion: e.pluginVersion, tool: e.tool, risk: e.risk, outcome: e.outcome, errorCode: e.errorCode,
    durationMs: e.durationMs, argsBytes: e.argsBytes, resultBytes: e.resultBytes,
  }
}

function file(e: Rec): PluginActivityFile | null {
  if (!isText(e.path) || !isText(e.address) || !isText(e.workspace) || !oneOf(OUTCOMES, e.outcome) ||
    !isCount(e.count) || !isTime(e.lastAt)) return null
  return { path: e.path, address: e.address, workspace: e.workspace, outcome: e.outcome, count: e.count, lastAt: e.lastAt }
}

function command(e: Rec): PluginActivityCommand | null {
  if (!isText(e.command) || !isText(e.workspace) || !oneOf(OUTCOMES, e.outcome) || !isCount(e.count) ||
    !isTime(e.lastAt)) return null
  return { command: e.command, workspace: e.workspace, outcome: e.outcome, count: e.count, lastAt: e.lastAt }
}

function day(e: Rec): PluginActivityDay | null {
  if (!isText(e.day) || !/^\d{4}-\d{2}-\d{2}$/.test(e.day) || !isCount(e.calls) || !isCount(e.denied) ||
    !isCount(e.errors)) return null
  return { day: e.day, calls: e.calls, denied: e.denied, errors: e.errors }
}

function unused(e: Rec): PluginActivityDeclaredUnused | null {
  if (!oneOf(UNUSED_KINDS, e.kind) || !isText(e.key) || !nullable(e.lastUsedAt, isTime)) return null
  return { kind: e.kind, key: e.key, lastUsedAt: e.lastUsedAt }
}

function undeclared(e: Rec): PluginActivityUndeclared | null {
  const reasons = list(e.reasons, (r) => (isText(r.reason) && isCount(r.count) ? { reason: r.reason, count: r.count } : null))
  if (!oneOf(SOURCES, e.source) || !isText(e.address) || !isText(e.workspace) || !isCount(e.count) ||
    !isTime(e.lastAt) || !reasons) return null
  return { source: e.source, address: e.address, workspace: e.workspace, count: e.count, lastAt: e.lastAt, reasons }
}

function anomaly(e: Rec): PluginActivityAnomaly | null {
  if (!oneOf(ANOMALY_KINDS, e.kind) || !isTime(e.at) || !isText(e.workspace) || !nullable(e.tool, isText) ||
    !nullable(e.count, isCount) || !nullable(e.baseline, (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return null
  return { kind: e.kind, at: e.at, workspace: e.workspace, tool: e.tool, count: e.count, baseline: e.baseline }
}

function agentAction(e: Rec): PluginAgentAction | null {
  if (!isTime(e.at) || !isText(e.action) || !oneOf(CALLER_KINDS, e.callerKind) || !isText(e.paneId) ||
    !isText(e.paneName) || !isText(e.workspace) || !isText(e.version)) return null
  return {
    at: e.at, action: e.action, callerKind: e.callerKind, paneId: e.paneId, paneName: e.paneName,
    workspace: e.workspace, version: e.version,
  }
}

/** A report rebuilt from validated fields (unknown fields are dropped), or
 *  null when anything is malformed: the page then says it cannot show one. */
export function parsePluginActivityReport(value: unknown): PluginActivityReport | null {
  if (!isRec(value) || value.schemaVersion !== PLUGIN_ACTIVITY_REPORT_SCHEMA_VERSION) return null
  const { window: span, totals } = value
  if (!isText(value.pluginId) || !isTime(value.generatedAt) || !isRec(span) || !isTime(span.from) ||
    !isTime(span.to) || !isRec(totals) || !isCount(totals.calls) || !isCount(totals.denied) ||
    !isCount(totals.errors) || !isCount(value.historicalPeakConcurrency) || !isTime(value.undeclaredSince)) return null
  const toolCalls = list(value.toolCalls, toolCall)
  const files = list(value.files, file)
  const commands = list(value.commands, command)
  const daily = list(value.daily, day)
  const declaredUnused = list(value.declaredUnused, unused)
  const undeclaredUses = list(value.undeclared, undeclared)
  const anomalies = list(value.anomalies, anomaly)
  const agentActions = value.agentActions === null ? null : list(value.agentActions, agentAction)
  const backendCalls = backendCallsOf(value.backendCalls)
  if (!toolCalls || !files || !commands || !daily || !declaredUnused || !undeclaredUses || !anomalies ||
    (value.agentActions !== null && agentActions === null) || !backendCalls) return null
  return {
    schemaVersion: PLUGIN_ACTIVITY_REPORT_SCHEMA_VERSION,
    pluginId: value.pluginId,
    generatedAt: value.generatedAt,
    window: { from: span.from, to: span.to },
    totals: { calls: totals.calls, denied: totals.denied, errors: totals.errors },
    historicalPeakConcurrency: value.historicalPeakConcurrency,
    undeclaredSince: value.undeclaredSince,
    toolCalls, files, commands, daily, declaredUnused, undeclared: undeclaredUses, anomalies, agentActions,
    backendCalls,
  }
}

const BACKEND_CALL_OUTCOMES: readonly PluginBackendCallOutcome[] = ['allowed', 'denied', 'cancelled', 'error']

function backendCallsOf(value: unknown): PluginActivityBackendCalls | null {
  if (!isRec(value)) return null
  const methods = list(value.methods, (e) =>
    isText(e.address) && e.address.startsWith('backend.') && oneOf(BACKEND_CALL_OUTCOMES, e.outcome) &&
    isCount(e.count) && isTime(e.lastAt)
      ? { address: e.address, outcome: e.outcome, count: e.count, lastAt: e.lastAt }
      : null)
  const daily = list(value.daily, (e) =>
    isText(e.day) && isCount(e.calls) && isCount(e.denied) && isCount(e.errors) && isCount(e.cancelled)
      ? { day: e.day, calls: e.calls, denied: e.denied, errors: e.errors, cancelled: e.cancelled }
      : null)
  return methods && daily ? { methods, daily } : null
}
