/**
 * Reading the two wire surfaces the Sharing pane is built on — `share.*` for
 * the offline bundle and `sync.inventory` for the cloud comparison.
 *
 * Kept out of the components because every judgement here is one a test has to
 * be able to pin without mounting: which reason an empty scope is empty for,
 * whether an unreadable cloud record is a conflict (it is not), and which
 * imported item still owes a credential.
 *
 * Every reader is tolerant of shape. Both backends answer with a scope map
 * whose values have been an array in one place and `{ items: [...] }` in
 * another, and a pane that throws on the spelling it did not expect is a pane
 * that shows nothing at all.
 */

export const SHARE_SCOPES = ['prompts', 'mcp', 'skills', 'memory'] as const
export type ShareScope = (typeof SHARE_SCOPES)[number]
/** The scopes cloud sync covers (2026-10-09: memory is no longer synced; a
 *  bundle still carries it, being a copy the user makes, not sync). */
export const CLOUD_SCOPES: readonly ShareScope[] = SHARE_SCOPES.filter((scope) => scope !== 'memory')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The rows of a `{ scope: [...] }` / `{ scope: { items: [...] } }` section. */
function sectionRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.items)) return value.items
  return []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ── the bundle half (share.*) ───────────────────────────────────────────────

export interface ShareItem {
  id: string
  label: string
  size: number
  /** env/header values are present and will be stripped on export. */
  hasSecrets: boolean
  /** args or url look like they carry a token, and export sends them as-is. */
  mayLeakInArgsOrUrl: boolean
  eligible: boolean
  reason: string
}

export function readShareInventory(payload: unknown): Record<ShareScope, ShareItem[]> {
  const scopes = isRecord(payload) ? payload.scopes : null
  const out = {} as Record<ShareScope, ShareItem[]>
  for (const scope of SHARE_SCOPES) {
    out[scope] = sectionRows(isRecord(scopes) ? scopes[scope] : null)
      .filter(isRecord)
      .map((row) => ({
        id: str(row.id),
        label: str(row.label) || str(row.id),
        size: typeof row.size === 'number' ? row.size : 0,
        hasSecrets: Boolean(row.hasSecrets),
        mayLeakInArgsOrUrl: Boolean(row.mayLeakInArgsOrUrl),
        // An item is shareable unless the backend says otherwise; a missing
        // flag must not silently grey out everything on an older backend.
        eligible: row.eligible === undefined ? true : Boolean(row.eligible),
        reason: str(row.reason),
      }))
      .filter((item) => item.id !== '')
  }
  return out
}

export type ImportAction = 'create' | 'overwrite' | 'skip'

export interface ImportPreviewRow {
  scope: string
  id: string
  action: ImportAction
  reason: string
  /** The whole record, as a sync approval shows it (MCP servers and skills). */
  summary?: Record<string, unknown>
  /** For an MCP overwrite: the url / command / args it would replace here. */
  local?: Record<string, unknown>
}

function readAction(value: unknown): ImportAction {
  return value === 'create' || value === 'overwrite' ? value : 'skip'
}

export function readPreviewRows(payload: unknown): ImportPreviewRow[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) ? payload.items : null
  return (Array.isArray(rows) ? rows : [])
    .filter(isRecord)
    .map((row) => ({
      scope: str(row.scope),
      id: str(row.id),
      action: readAction(row.action),
      reason: str(row.reason),
      ...(isRecord(row.summary) ? { summary: row.summary } : {}),
      ...(isRecord(row.local) ? { local: row.local } : {}),
    }))
    .filter((row) => row.scope !== '' && row.id !== '')
}

export interface ImportResultRow extends ImportPreviewRow {
  ok: boolean
}

export function readApplyRows(payload: unknown): ImportResultRow[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) ? payload.items : null
  return (Array.isArray(rows) ? rows : [])
    .filter(isRecord)
    .map((row) => ({
      scope: str(row.scope),
      id: str(row.id),
      action: readAction(row.action),
      reason: str(row.reason),
      ok: row.ok !== false,
    }))
    .filter((row) => row.scope !== '' && row.id !== '')
}

export function rowKey(scope: string, id: string): string {
  // The four scope names carry no "::" and are fixed, so this cannot collide.
  return `${scope}::${id}`
}

/**
 * Which items of a bundle arrived without their secrets, as `rowKey`s.
 *
 * The export writes this list itself (`redactions: [{ scope, item, fields }]`),
 * which is the only place the information survives — the item's own payload by
 * then just has empty strings where the values were, and an empty string is
 * also what somebody who never set the value has.
 */
export function redactedKeys(bundle: unknown): Set<string> {
  const rows = isRecord(bundle) ? bundle.redactions : null
  const out = new Set<string>()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue
    const scope = str(row.scope)
    const item = str(row.item) || str(row.id)
    if (scope && item) out.add(rowKey(scope, item))
  }
  return out
}

/** The fields a bundle redacted for one item, for the "fill these in" line. */
export function redactedFields(bundle: unknown, scope: string, id: string): string[] {
  const rows = isRecord(bundle) ? bundle.redactions : null
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue
    if (str(row.scope) !== scope) continue
    if ((str(row.item) || str(row.id)) !== id) continue
    return (Array.isArray(row.fields) ? row.fields : []).map(str).filter(Boolean)
  }
  return []
}

export function bundleItemCount(bundle: unknown): number {
  const scopes = isRecord(bundle) ? bundle.scopes : null
  if (!isRecord(scopes)) return 0
  let total = 0
  for (const section of Object.values(scopes)) {
    const items = isRecord(section) ? section.items : null
    if (isRecord(items)) total += Object.keys(items).length
  }
  return total
}

// ── the cloud half (sync.inventory) ─────────────────────────────────────────

export type SyncState = 'in-sync' | 'local-only' | 'remote-only' | 'diverged' | 'conflict'
/** What the row is labelled as on screen. `unreadable` is not a wire state: it
 *  is a cloud record written under another key, which the engine can only
 *  report as `diverged` and which nobody could ever resolve as one. */
export type DisplayState = SyncState | 'unreadable'
export type ScopeStatus = 'ok' | 'no-key' | 'not-connected' | 'error' | 'unknown-scope'

const SYNC_STATES: readonly SyncState[] = [
  'in-sync',
  'local-only',
  'remote-only',
  'diverged',
  'conflict',
]

export interface SyncRow {
  itemId: string
  localPresent: boolean
  remotePresent: boolean
  /** False only when a cloud record exists and this machine cannot open it. */
  remoteReadable: boolean
  deviceId: string
  /** When the cloud copy was last *written*, not when its device was last up. */
  updatedAt: string
  state: SyncState
}

export interface SyncScopeView {
  scope: string
  status: ScopeStatus
  error: string
  items: SyncRow[]
}

export interface SyncDevice {
  deviceId: string
  deviceName: string
  /** Last time the server saw the device online; '' when it never said. */
  lastSeenAt: string
  /** Last time the device wrote a record to this account. */
  lastWriteAt: string
}

export interface SyncInventoryView {
  status: ScopeStatus
  scopes: Record<string, SyncScopeView>
  devices: SyncDevice[]
  scopeEnabled: Record<string, boolean>
}

function readStatus(value: unknown): ScopeStatus {
  return value === 'ok' ||
    value === 'no-key' ||
    value === 'not-connected' ||
    value === 'error' ||
    value === 'unknown-scope'
    ? value
    : 'error'
}

function readRow(value: unknown): SyncRow | null {
  if (!isRecord(value)) return null
  const itemId = str(value.itemId) || str(value.id)
  if (!itemId) return null
  const local = isRecord(value.local) ? value.local : null
  const remote = isRecord(value.remote) ? value.remote : null
  const state = SYNC_STATES.find((s) => s === value.state) ?? 'diverged'
  return {
    itemId,
    localPresent: local !== null && local.present !== false,
    remotePresent: remote !== null && remote.present !== false,
    // Only a record that is actually there can be unreadable; "no record"
    // must not come out looking like "we could not open it".
    remoteReadable: remote === null ? true : remote.readable !== false,
    deviceId: remote ? str(remote.deviceId) : '',
    updatedAt: remote ? str(remote.updatedAt) : '',
    state,
  }
}

export function readSyncInventory(payload: unknown): SyncInventoryView {
  const root = isRecord(payload) ? payload : {}
  const rawScopes = isRecord(root.scopes) ? root.scopes : {}
  const scopes: Record<string, SyncScopeView> = {}
  for (const scope of SHARE_SCOPES) {
    const section = rawScopes[scope]
    if (!isRecord(section)) continue
    scopes[scope] = {
      scope,
      status: readStatus(section.status),
      error: str(section.error),
      items: sectionRows(section.items).map(readRow).filter((r): r is SyncRow => r !== null),
    }
  }
  const devices = (Array.isArray(root.devices) ? root.devices : [])
    .filter(isRecord)
    .map((row) => ({
      deviceId: str(row.deviceId),
      deviceName: str(row.deviceName),
      // Two different questions, kept apart: a machine that has been online
      // all week and changed nothing must not look like one that wrote today.
      lastSeenAt: str(row.lastSeenAt),
      lastWriteAt: str(row.lastWriteAt),
    }))
    // A device with no name is still a device. Dropping it here would hide
    // every machine on today's server, which names none of them.
    .filter((row) => row.deviceId !== '')
  const enabled: Record<string, boolean> = {}
  if (isRecord(root.scopeEnabled)) {
    for (const [scope, value] of Object.entries(root.scopeEnabled)) enabled[scope] = Boolean(value)
  }
  return { status: readStatus(root.status), scopes, devices, scopeEnabled: enabled }
}

export function displayState(row: SyncRow): DisplayState {
  return row.remotePresent && !row.remoteReadable ? 'unreadable' : row.state
}

/** Whether moving this row either way is something the user can ask for. */
export function isActionable(row: SyncRow): boolean {
  const shown = displayState(row)
  return shown !== 'in-sync' && shown !== 'unreadable' && shown !== 'conflict'
}

export type ScopeNotice = ScopeStatus | 'disabled' | 'empty' | null

/**
 * Why this scope's list is the way it is — one message per cause, never a
 * shared "no data". A scope whose sync is switched off still lists (the
 * backend answers for it on purpose), so `disabled` rides alongside the rows
 * rather than replacing them.
 */
export function scopeNotice(view: SyncScopeView, enabled: boolean): ScopeNotice {
  if (view.status !== 'ok') return view.status
  if (!enabled) return 'disabled'
  return view.items.length === 0 ? 'empty' : null
}

/** A device's shortest unambiguous name: what the server called it, or its id. */
export function deviceLabel(deviceId: string, deviceName = ''): string {
  const name = deviceName.trim()
  if (name) return name
  return deviceId.length > 8 ? deviceId.slice(0, 8) : deviceId
}
