/**
 * Plugin activity (plan B, D-e): capability-broker calls counted per
 * (plugin, version, workspace, address, outcome, reason, path, command,
 * minute) within each batch, and the calls into a third-party plugin's own
 * backend (whichever path made them: its frontend, an agent tool, an agent
 * capability request) counted per (plugin, version, workspace,
 * `backend.<method>`, outcome) within each batch (source `backend`). Every
 * row carries its `count`.
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
import {
  HOST_EVENT_SOURCE_PLUGIN_ID,
  isKnownCapabilityAddress,
  isUndeclaredDenial,
  isUndispatched,
  type CapabilityCall,
  type CapabilityResponse,
} from './pluginCapabilityBroker'

/** The one address every call of a capability the broker does not know is
 *  counted under (contract 5): such names are the plugin's free text, with no
 *  limit on their length or variety, so they are never keys. */
export const ACTIVITY_UNKNOWN_ADDRESS = '<unknown>'
/** The path or command of a refused call, and of a failed one: the plugin
 *  wrote it, the call cost it nothing, so it is never a key (contract 5). */
export const ACTIVITY_DENIED_TARGET = '<denied>'
export const ACTIVITY_FAILED_TARGET = '<failed>'
/** The path of an allowed read whose result found nothing there or failed
 *  (`exists: false`, as `fs.stat` answers for a missing path, or `ok: false`,
 *  as `fs.readFile` / `fs.listDirectory` answer for one): it cost a stat, so
 *  it is no key. A write keeps its path whatever it answered: it may have
 *  changed something before it failed. */
export const ACTIVITY_MISSING_TARGET = '<missing>'
const MARKERS: ReadonlySet<string> = new Set([
  ACTIVITY_UNKNOWN_ADDRESS, ACTIVITY_DENIED_TARGET, ACTIVITY_FAILED_TARGET, ACTIVITY_MISSING_TARGET,
])

/** A plugin's own path or command that is spelled like a fixed value is sent
 *  as `./<value>`, so it is never read as one. */
function plainText(value: string): string {
  return MARKERS.has(value) ? `./${value}` : value
}

/** Calls known to change nothing (PLUGIN_ACTIVITY_READ_ONLY_ADDRESSES): a failed
 *  one is ACTIVITY_FAILED_TARGET. Any other failed call that reached a handler
 *  keeps its path and command (a new address too): it may have done something
 *  before it failed. One answered before dispatch, or of an unknown address,
 *  ran nothing. */
export const READ_ONLY_ADDRESSES: ReadonlySet<string> = new Set([
  'fs.readFile', 'fs.readImage', 'fs.listDirectory', 'fs.listFilesFlat', 'fs.glob', 'fs.stat', 'fs.statPath',
  'fs.listArchive', 'fs.previewResource', 'fs.convertOffice',
  'fs.read_file', 'fs.read_image', 'fs.list_dir', 'fs.list_files_flat', 'fs.glob_files', 'fs.stat_path',
  'fs.list_archive', 'fs.convert_office',
])

/** Read-only calls that answer a missing path inside a successful call. */
const READS_ANSWERING_MISSING: ReadonlySet<string> = new Set([
  'fs.readFile', 'fs.readImage', 'fs.listDirectory', 'fs.stat', 'fs.statPath',
])

function foundNothing(call: CapabilityCall, response: CapabilityResponse): boolean {
  if (!READS_ANSWERING_MISSING.has(`${call.ns}.${call.method}`)) return false
  const result = response.result
  if (typeof result !== 'object' || result === null) return false
  const fields = result as Record<string, unknown>
  return fields.exists === false || fields.ok === false
}

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
  /** When the (last counted) call completed (Unix ms). The backend clamps it to its own now. */
  at: number
  /** Calls with this key in the same minute of one batch. */
  count: number
}

/** Backend calls counted within one batch (source `backend`), per minute. */
export interface BackendCallActivityRow {
  /** Start of the minute (Unix ms) the calls fell in. */
  at: number
  plugin_id: string
  plugin_version: string
  workspace: string
  source: 'backend'
  address: string
  outcome: BackendCallActivityOutcome
  count: number
}

/** Card K4: a Host setting the user changed that governs which Navide
 *  plugins may run, filed under the Host's own event identity (never a
 *  plugin id). Only the Host builds these, through `recordHostEvent`. */
export interface HostEventActivityRow {
  at: number
  plugin_id: typeof HOST_EVENT_SOURCE_PLUGIN_ID
  plugin_version: string
  workspace: ''
  source: 'host'
  address: HostEventAddress
  outcome: 'allowed'
  count: 1
}

export type HostEventAddress = 'developerMode.on' | 'developerMode.off'

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
  /** When the call completed; now when omitted. */
  at?: number
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : undefined
}

/** The activity row of one broker call. Raw path and command text of an
 *  allowed call go to the backend, which keeps only their redacted form; a
 *  refused or failed call's are a fixed marker, an allowed call that found
 *  nothing there is ACTIVITY_MISSING_TARGET, and a capability the broker
 *  does not know is ACTIVITY_UNKNOWN_ADDRESS. */
export function activityRowFor({ pluginId, packageVersion, workspace, call, response, at }: PluginActivityInput): PluginActivityRow {
  const outcome: PluginActivityOutcome = response.ok
    ? 'allowed'
    : DENIED_CODES.has(response.error?.code ?? '') ? 'denied' : 'error'
  const row: PluginActivityRow = {
    plugin_id: pluginId,
    plugin_version: packageVersion ?? '',
    workspace: workspace ?? '',
    source: call.ns === 'shell' ? 'shell' : 'broker',
    address: isKnownCapabilityAddress(call.ns, call.method) ? `${call.ns}.${call.method}` : ACTIVITY_UNKNOWN_ADDRESS,
    outcome,
    // Dated here, not when the batch is sent: a call just before midnight
    // stays on its own day.
    at: at ?? Date.now(),
    count: 1,
  }
  if (outcome === 'denied' && isUndeclaredDenial(response)) row.denied_reason = 'undeclared'
  const kept = outcome === 'allowed' || (
    outcome === 'error' && row.address !== ACTIVITY_UNKNOWN_ADDRESS
    && !READ_ONLY_ADDRESSES.has(row.address) && !isUndispatched(response)
  )
  const target = (value: string): string =>
    kept ? plainText(value) : outcome === 'denied' ? ACTIVITY_DENIED_TARGET : ACTIVITY_FAILED_TARGET
  const fsPath = call.ns === 'fs' ? stringArg(call.args, 'path') : undefined
  if (fsPath) row.fs_path = outcome === 'allowed' && foundNothing(call, response) ? ACTIVITY_MISSING_TARGET : target(fsPath)
  const command = call.ns === 'shell' ? stringArg(call.args, 'command') : undefined
  if (command) row.shell_command = target(command)
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
  payload: { rows: Array<PluginActivityRow | BackendCallActivityRow | HostEventActivityRow> },
) => Promise<unknown> | unknown

/** Counts rows per key and sends them to the backend about once a second. */
export class PluginActivityRecorder {
  /** Broker calls of this batch, counted per key and minute (one map lookup per call). */
  private queue = new Map<string, PluginActivityRow>()
  /** Backend calls of this batch, counted per key (one map lookup per call). */
  private backendCalls = new Map<string, BackendCallActivityRow>()
  /** Host events of this batch, one row each (never counted together). */
  private hostEvents: HostEventActivityRow[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: () => PluginActivitySend | null,
    private readonly intervalMs = 1000,
  ) {}

  /** Count one row into this batch's row for its key and minute; never throws. */
  record(row: PluginActivityRow): void {
    // A plugin call is never a Host event, whatever a caller put in it.
    if ((row.source as string) === 'host') return
    const minute = row.at - (row.at % 60_000)
    const key = `${minute}\u0000${row.plugin_id}\u0000${row.plugin_version}\u0000${row.workspace}\u0000${row.source}`
      + `\u0000${row.address}\u0000${row.outcome}\u0000${row.denied_reason ?? ''}\u0000${row.fs_path ?? ''}`
      + `\u0000${row.shell_command ?? ''}`
    const counted = this.queue.get(key)
    if (counted) {
      counted.count += row.count
      if (row.at > counted.at) counted.at = row.at
    } else {
      this.queue.set(key, { ...row })
    }
    this.schedule()
  }

  /** Count one backend call into this batch's row for its key and minute; never throws. */
  recordBackendCall(call: Omit<BackendCallActivityRow, 'source' | 'count' | 'at'>, at: number = Date.now()): void {
    const minute = at - (at % 60_000)
    const key = `${minute}\u0000${call.plugin_id}\u0000${call.plugin_version}\u0000${call.workspace}\u0000${call.address}\u0000${call.outcome}`
    const row = this.backendCalls.get(key)
    if (row) row.count += 1
    else this.backendCalls.set(key, { ...call, at: minute, source: 'backend', count: 1 })
    this.schedule()
  }

  /** Card K4: one Host event (the Developer Mode switch); never throws. */
  recordHostEvent(address: HostEventAddress, appVersion: string, at: number = Date.now()): void {
    this.hostEvents.push({
      at, plugin_id: HOST_EVENT_SOURCE_PLUGIN_ID, plugin_version: appVersion, workspace: '',
      source: 'host', address, outcome: 'allowed', count: 1,
    })
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
    const rows: Array<PluginActivityRow | BackendCallActivityRow | HostEventActivityRow> = [
      ...this.queue.values(), ...this.backendCalls.values(), ...this.hostEvents,
    ]
    this.queue = new Map()
    this.backendCalls = new Map()
    this.hostEvents = []
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
    return this.queue.size + this.backendCalls.size + this.hostEvents.length
  }
}
