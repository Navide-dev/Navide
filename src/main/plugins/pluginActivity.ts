/**
 * Plugin activity (plan B, D-e): one row per capability-broker call, and the
 * calls into a third-party plugin's own backend (whichever path made them: its
 * frontend, an agent tool, an agent capability request) counted per
 * (plugin, version, workspace, `backend.<method>`, outcome) within each batch
 * (source `backend`, with `count`).
 *
 * The broker records what a Navide plugin asked for and what came of it: the
 * plugin, the `namespace.method` address, the workspace, an fs path or a shell
 * command line, and whether the call was allowed, denied (and whether because
 * the manifest did not declare it) or failed. Rows are queued here and sent to
 * the backend in batches (`plugin.activity.record`), which redacts them — a
 * workspace-relative path only, the executable and subcommand only — and
 * stores them in `plugin_activity`.
 *
 * Write-only and never in the way: recording only pushes onto a queue, a batch
 * that cannot be sent is dropped, and nothing here can fail or delay the call
 * it records.
 */

import { PLUGIN_ACTIVITY_RECORD_MESSAGE } from '../../shared/pluginAgentTools'
import { isUndeclaredDenial, type CapabilityCall, type CapabilityResponse } from './pluginCapabilityBroker'

export type PluginActivitySource = 'broker' | 'shell' | 'backend'
export type PluginActivityOutcome = 'allowed' | 'denied' | 'error'
/** A backend call can also be cancelled by its caller (not a refusal). */
export type BackendCallActivityOutcome = PluginActivityOutcome | 'cancelled'

export interface PluginActivityRow {
  plugin_id: string
  plugin_version: string
  workspace: string
  source: PluginActivitySource
  address: string
  outcome: PluginActivityOutcome
  denied_reason?: 'undeclared'
  fs_path?: string
  shell_command?: string
}

/** Backend calls counted within one batch (source `backend`). */
export interface BackendCallActivityRow {
  plugin_id: string
  plugin_version: string
  workspace: string
  source: 'backend'
  address: string
  outcome: BackendCallActivityOutcome
  count: number
}

/** Broker refusals: the call never ran. Anything else that is not ok failed. */
const DENIED_CODES: ReadonlySet<string> = new Set([
  'CAP_DENIED',
  'CAPABILITY_DENIED',
  'WORKSPACE_SCOPE_VIOLATION',
  'USER_CANCELLED',
])

export interface PluginActivityInput {
  pluginId: string
  packageVersion: string | null | undefined
  workspace: string | null | undefined
  call: CapabilityCall
  response: CapabilityResponse
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : undefined
}

/** The activity row of one broker call. Raw path and command text go to the
 *  backend, which keeps only their redacted form. */
export function activityRowFor({ pluginId, packageVersion, workspace, call, response }: PluginActivityInput): PluginActivityRow {
  const outcome: PluginActivityOutcome = response.ok
    ? 'allowed'
    : DENIED_CODES.has(response.error?.code ?? '') ? 'denied' : 'error'
  const row: PluginActivityRow = {
    plugin_id: pluginId,
    plugin_version: packageVersion ?? '',
    workspace: workspace ?? '',
    source: call.ns === 'shell' ? 'shell' : 'broker',
    address: `${call.ns}.${call.method}`,
    outcome,
  }
  if (outcome === 'denied' && isUndeclaredDenial(response)) row.denied_reason = 'undeclared'
  const fsPath = call.ns === 'fs' ? stringArg(call.args, 'path') : undefined
  if (fsPath) row.fs_path = fsPath
  const command = call.ns === 'shell' ? stringArg(call.args, 'command') : undefined
  if (command) row.shell_command = command
  return row
}

/** The address a backend call is recorded under, and a declared backend
 *  method is keyed by (contract 5): `backend.<method>`, so a method named like
 *  a system namespace (`fs.read`) never counts as a use of that namespace. */
export function backendCallAddress(method: string): string {
  return `backend.${method}`
}

export type PluginActivitySend = (
  type: string,
  payload: { rows: Array<PluginActivityRow | BackendCallActivityRow> },
) => Promise<unknown> | unknown

/** Queues rows and sends them to the backend about once a second. */
export class PluginActivityRecorder {
  private queue: PluginActivityRow[] = []
  /** Backend calls of this batch, counted per key (one map lookup per call). */
  private backendCalls = new Map<string, BackendCallActivityRow>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: () => PluginActivitySend | null,
    private readonly intervalMs = 1000,
  ) {}

  /** Queue one row; never throws. */
  record(row: PluginActivityRow): void {
    this.queue.push(row)
    this.schedule()
  }

  /** Count one backend call into this batch's row for its key; never throws. */
  recordBackendCall(call: Omit<BackendCallActivityRow, 'source' | 'count'>): void {
    const key = `${call.plugin_id}\u0000${call.plugin_version}\u0000${call.workspace}\u0000${call.address}\u0000${call.outcome}`
    const row = this.backendCalls.get(key)
    if (row) row.count += 1
    else this.backendCalls.set(key, { ...call, source: 'backend', count: 1 })
    this.schedule()
  }

  private schedule(): void {
    if (this.timer === null) {
      this.timer = setTimeout(() => { void this.flush() }, this.intervalMs)
      this.timer.unref?.()
    }
  }

  /** Send what is queued; a batch with no backend to take it, or that fails, is dropped. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const rows: Array<PluginActivityRow | BackendCallActivityRow> = [...this.queue, ...this.backendCalls.values()]
    this.queue = []
    this.backendCalls = new Map()
    if (rows.length === 0) return
    try {
      const send = this.send()
      if (send) await send(PLUGIN_ACTIVITY_RECORD_MESSAGE, { rows })
    } catch (error) {
      console.debug(`[plugins] ${rows.length} activity rows not recorded:`, error)
    }
  }

  /** Rows waiting to be sent (diagnostics and tests). */
  get pending(): number {
    return this.queue.length + this.backendCalls.size
  }
}
